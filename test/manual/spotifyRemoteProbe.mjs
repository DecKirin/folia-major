import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';

// test/manual/spotifyRemoteProbe.mjs

/**
 * Phase 0 of playing Spotify songs through the Spotify desktop app: whether Folia's own sign-in
 * (the desktop client id, electron/spotify/signIn.cjs) can see the app as a Connect device, start a
 * list of tracks on it at a given one, follow what it plays and steer it. Nothing of the app's own
 * code is changed or used beyond the sign-in.
 *
 * It signs in by itself (the browser opens Spotify's consent page) and keeps the tokens in memory
 * only: the sign-in Folia stores is not read or touched. The Spotify app must be installed and
 * signed in to the same account; the probe opens it when it is not running.
 *
 * Steps: client token → dealer socket and its connection id → registered as a hidden observer
 * (`hobs_`) → the devices, and which is this computer's app → `play` a bare list of three tracks
 * from the second → a quiet stretch (how often the position is pushed) → seek, pause, resume,
 * skip_next → seek near the end of the last track (what plays after the list) → pause.
 *
 * Usage:
 *   node --experimental-websocket test/manual/spotifyRemoteProbe.mjs [--report <file.json>]
 *       [--tracks <id>,<id>,<id>] [--device <device id>] [--no-play]
 * The report holds no token.
 */

const require = createRequire(import.meta.url);
const { createSpotifySignIn, CLIENT_ID } = require('../../electron/spotify/signIn.cjs');

const args = process.argv.slice(2);
const argValue = name => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
};
const REPORT_PATH = argValue('--report') ?? `${os.tmpdir()}/folia-spotify-remote-probe.json`;
const TRACK_IDS = (argValue('--tracks') ?? '4uLU6hMCjMI75M1A2tKUQC,3n3Ppam7vgaVa1iaRUc9Lp,7qiZfU4dY1lWllzX7mPBI3').split(',');
const WANTED_DEVICE = argValue('--device');
const PLAY = !args.includes('--no-play');

const report = { startedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, steps: [], updates: [] };
const startedAt = Date.now();
const since = () => Date.now() - startedAt;
const step = (name, outcome) => {
    report.steps.push({ at: since(), name, ...outcome });
    console.log(`[Probe] ${name}: ${JSON.stringify(outcome)}`);
};
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const hex = bytes => randomBytes(bytes).toString('hex');

// --- protobuf, by hand: the client-token request is four scalars and the answer is read for two ---

const varint = value => {
    const out = [];
    let left = value;
    while (left > 0x7f) {
        out.push((left & 0x7f) | 0x80);
        left = Math.floor(left / 128);
    }
    out.push(left);
    return Buffer.from(out);
};
const fieldVarint = (field, value) => Buffer.concat([varint(field << 3), varint(value)]);
const fieldBytes = (field, bytes) => Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
const fieldString = (field, text) => fieldBytes(field, Buffer.from(text, 'utf8'));

// The fields of one message: { [field]: [values] }, varints as numbers and the rest as Buffers.
const readFields = buffer => {
    const fields = {};
    let at = 0;
    const readVarint = () => {
        let value = 0;
        let scale = 1;
        for (;;) {
            const byte = buffer[at++];
            value += (byte & 0x7f) * scale;
            if (byte < 0x80) return value;
            scale *= 128;
        }
    };
    while (at < buffer.length) {
        const key = readVarint();
        const field = Math.floor(key / 8);
        const wire = key & 7;
        let value;
        if (wire === 0) value = readVarint();
        else if (wire === 2) {
            const length = readVarint();
            value = buffer.subarray(at, at + length);
            at += length;
        } else if (wire === 1) { value = buffer.subarray(at, at + 8); at += 8; }
        else if (wire === 5) { value = buffer.subarray(at, at + 4); at += 4; }
        else throw new Error(`wire type ${wire}`);
        (fields[field] ??= []).push(value);
    }
    return fields;
};

// The Client-Token spclient wants beside the bearer. It names the application, not the account.
async function clientToken(deviceId) {
    const platform = process.platform === 'darwin' ? 3 : process.platform === 'win32' ? 2 : 1;
    const body = Buffer.concat([
        fieldVarint(1, 1),
        fieldBytes(2, Buffer.concat([
            fieldString(1, '0.0.0'),
            fieldString(2, CLIENT_ID),
            fieldBytes(3, Buffer.concat([fieldBytes(1, fieldBytes(platform, Buffer.alloc(0))), fieldString(2, deviceId)])),
        ])),
    ]);
    const response = await fetch('https://clienttoken.spotify.com/v1/clienttoken', {
        method: 'POST', headers: { 'Content-Type': 'application/x-protobuf', Accept: 'application/x-protobuf' }, body,
    });
    const answer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`clienttoken HTTP ${response.status}`);
    const fields = readFields(answer);
    if (fields[1]?.[0] !== 1) throw new Error(`clienttoken response type ${fields[1]?.[0]} (2 is a challenge)`);
    const granted = readFields(fields[2][0]);
    return { token: granted[1][0].toString('utf8'), expiresInS: granted[2]?.[0] };
}

// --- sign-in, in this process only ---

async function signIn() {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const flow = createSpotifySignIn({
        fetch, openExternal: async url => { spawnSync(opener, [url]); }, language: () => 'en',
        log: () => {}, warn: (...words) => console.warn(...words),
    });
    const { key } = await flow.start();
    await flow.open(key);
    console.log('[Probe] Approve the sign-in in the browser window that opened (waiting up to 5 min)');
    for (let waited = 0; waited < 5 * 60 * 1000; waited += 1000) {
        const state = flow.check(key);
        if (state.state === 'approved') {
            flow.finish(key);
            return state.tokens;
        }
        if (state.state !== 'waiting') throw new Error(`sign-in ended: ${state.state} ${state.message ?? ''}`);
        await pause(1000);
    }
    flow.cancel();
    throw new Error('sign-in was not approved in time');
}

// --- the probe ---

const computerName = () => {
    try {
        if (process.platform === 'darwin') return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim();
    } catch { /* the host name below */ }
    return os.hostname();
};

// What one cluster says, in the few fields the route would read.
const playerOf = cluster => {
    const state = cluster?.player_state ?? {};
    return {
        activeDevice: cluster?.active_device_id ?? null,
        track: state.track?.uri ?? null,
        context: state.context_uri ?? null,
        paused: state.is_paused ?? null,
        playing: state.is_playing ?? null,
        positionAsOf: state.position_as_of_timestamp != null ? Number(state.position_as_of_timestamp) : null,
        timestamp: state.timestamp != null ? Number(state.timestamp) : null,
        duration: state.duration != null ? Number(state.duration) : null,
        speed: state.playback_speed ?? null,
        options: state.options ?? null,
        nextTracks: Array.isArray(state.next_tracks) ? state.next_tracks.slice(0, 3).map(track => track?.uri) : null,
    };
};
const devicesOf = cluster => Object.values(cluster?.devices ?? {}).map(device => ({
    id: device.device_id, name: device.name, type: device.device_type, active: device.device_id === cluster.active_device_id,
    software: device.device_software_version ?? null, brand: device.brand ?? null, model: device.model ?? null,
}));

// A dealer payload: an object already, or base64 of JSON or of gzipped JSON (or of protobuf).
const readPayload = (payload, headers) => {
    if (payload && typeof payload === 'object') return { json: payload, form: 'object' };
    if (typeof payload !== 'string') return { form: typeof payload };
    let bytes = Buffer.from(payload, 'base64');
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (gzipped) bytes = gunzipSync(bytes);
    const text = bytes.toString('utf8');
    if (text.startsWith('{')) return { json: JSON.parse(text), form: gzipped ? 'base64 gzip json' : 'base64 json' };
    return { form: `${gzipped ? 'base64 gzip ' : 'base64 '}binary (${bytes.length} bytes, content-type ${headers?.['Content-Type'] ?? '?'})` };
};

async function main() {
    const tokens = await signIn();
    step('sign-in', { ok: true, expiresInS: Math.round((tokens.expires_at - Date.now()) / 1000) });
    const bearer = tokens.access_token;

    const product = await fetch('https://spclient.wg.spotify.com/melody/v1/product_state?market=from_token', {
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    }).then(response => (response.ok ? response.json() : { status: response.status })).catch(error => ({ error: String(error) }));
    step('account plan', { catalogue: product.catalogue ?? null, product: product.product ?? null, status: product.status ?? null });

    const deviceId = hex(20);
    let client = null;
    try {
        client = await clientToken(deviceId);
        step('client token', { ok: true, expiresInS: client.expiresInS });
    } catch (error) {
        step('client token', { ok: false, error: String(error?.message ?? error) });
    }

    const resolved = await fetch('https://apresolve.spotify.com/?type=dealer&type=spclient').then(response => response.json());
    const dealerHost = resolved.dealer?.[0]?.replace(/:443$/, '') ?? 'dealer.spotify.com';
    const spclientHost = resolved.spclient?.[0]?.replace(/:443$/, '') ?? 'spclient.wg.spotify.com';
    step('apresolve', { dealerHost, spclientHost });

    const spclient = async (method, path, body, { withClientToken = true, headers = {} } = {}) => {
        const response = await fetch(`https://${spclientHost}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${bearer}`, Accept: 'application/json', 'Content-Type': 'application/json',
                ...(withClientToken && client ? { 'client-token': client.token } : {}), ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: response.status, json, text: json ? undefined : text.slice(0, 300) };
    };

    // The dealer socket: its first message names the connection id registration needs.
    let latest = null;
    let connectionId = null;
    const listeners = new Set();
    const socket = new WebSocket(`wss://${dealerHost}/?access_token=${encodeURIComponent(bearer)}`);
    socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === 'ping') { socket.send('{"type":"pong"}'); return; }
        if (message.type !== 'message' && message.type !== 'request') return;
        const announced = message.headers?.['Spotify-Connection-Id'];
        if (announced) { connectionId = announced; return; }
        if (!String(message.uri ?? '').startsWith('hm://connect-state/v1/cluster')) {
            report.updates.push({ at: since(), uri: message.uri, type: message.type });
            return;
        }
        for (const payload of message.payloads ?? []) {
            const read = readPayload(payload, message.headers);
            const cluster = read.json?.cluster ?? read.json;
            const update = { at: since(), receivedAtMs: Date.now(), form: read.form, reason: read.json?.update_reason ?? null };
            if (cluster?.player_state || cluster?.devices) {
                latest = cluster;
                Object.assign(update, playerOf(cluster), { devicesChanged: read.json?.devices_that_changed ?? null });
            }
            report.updates.push(update);
            for (const listener of listeners) listener(update);
        }
    });
    const opened = await Promise.race([
        new Promise(resolve => { socket.addEventListener('open', () => resolve(true), { once: true }); }),
        new Promise(resolve => { socket.addEventListener('error', () => resolve(false), { once: true }); }),
        pause(15000).then(() => false),
    ]);
    const pinger = setInterval(() => { if (socket.readyState === 1) socket.send('{"type":"ping"}'); }, 30000);
    for (let waited = 0; opened && !connectionId && waited < 15000; waited += 50) await pause(50);
    step('dealer', { opened, connectionId: Boolean(connectionId) });
    if (!connectionId) throw new Error('the dealer never named a connection id');

    // Registered as a hidden observer; the answer is the cluster as it is now.
    const observer = `hobs_${deviceId}`;
    const registration = {
        member_type: 'CONNECT_STATE',
        device: { device_info: { capabilities: { can_be_player: false, hidden: true, needs_full_player_state: true } } },
    };
    let registered = await spclient('PUT', `/connect-state/v1/devices/${observer}`, registration,
        { withClientToken: false, headers: { 'X-Spotify-Connection-Id': connectionId } });
    step('register without client token', { status: registered.status, text: registered.text });
    if (registered.status >= 300 && client) {
        registered = await spclient('PUT', `/connect-state/v1/devices/${observer}`, registration,
            { headers: { 'X-Spotify-Connection-Id': connectionId } });
        step('register with client token', { status: registered.status, text: registered.text });
    }
    if (registered.status >= 300 || !registered.json) throw new Error(`registration answered ${registered.status}`);
    latest = registered.json;
    const name = computerName();
    step('devices', { computerName: name, hostName: os.hostname(), devices: devicesOf(latest), player: playerOf(latest) });

    // This computer's app: asked for, or the computer device named like this computer, or the only one.
    const findTarget = () => {
        const devices = devicesOf(latest);
        if (WANTED_DEVICE) return devices.find(device => device.id === WANTED_DEVICE) ?? null;
        const computers = devices.filter(device => String(device.type).toUpperCase() === 'COMPUTER' && !String(device.id).startsWith('hobs_'));
        return computers.find(device => device.name === name || device.name === os.hostname()) ?? (computers.length === 1 ? computers[0] : null);
    };
    let target = findTarget();
    if (!target) {
        const launch = process.platform === 'darwin' ? ['open', ['-g', '-a', 'Spotify']] : process.platform === 'win32' ? ['explorer', ['spotify:']] : ['spotify', []];
        spawnSync(launch[0], launch[1], { detached: true, stdio: 'ignore' });
        step('opened the app', { command: launch[0] });
        for (let waited = 0; !target && waited < 25000; waited += 1000) {
            await pause(1000);
            const fresh = await spclient('PUT', `/connect-state/v1/devices/${observer}`, registration, { headers: { 'X-Spotify-Connection-Id': connectionId } });
            if (fresh.json) latest = fresh.json;
            target = findTarget();
        }
    }
    step('target', { found: Boolean(target), device: target, devices: devicesOf(latest) });
    if (!target || !PLAY) return;

    // Sends one command and waits for the first cluster update after it (or 8 s).
    const command = async (label, body) => {
        let first = null;
        const seen = new Promise(resolve => {
            const listener = update => { if (update.track !== undefined) { first = update; listeners.delete(listener); resolve(); } };
            listeners.add(listener);
            pause(8000).then(() => { listeners.delete(listener); resolve(); });
        });
        const sentAt = Date.now();
        const answer = await spclient('POST', `/connect-state/v1/player/command/from/${observer}/to/${target.id}`, {
            command: { ...body, logging_params: { command_id: hex(16) } },
        });
        await seen;
        step(label, {
            status: answer.status, answer: answer.json ?? answer.text, echoMs: first ? first.receivedAtMs - sentAt : null,
            after: first ? { track: first.track, paused: first.paused, positionAsOf: first.positionAsOf, timestamp: first.timestamp, duration: first.duration } : null,
        });
        return first;
    };
    const uris = TRACK_IDS.map(id => `spotify:track:${id}`);

    await command('play a bare list from its second track', {
        endpoint: 'play',
        context: { uri: '', url: '', pages: [{ tracks: uris.map(uri => ({ uri })) }] },
        play_origin: { feature_identifier: 'folia', feature_version: 'probe' },
        options: { skip_to: { track_uri: uris[1], track_index: 1 } },
    });
    // A quiet stretch: how often the position is pushed while nothing is asked of the app.
    const quietFrom = since();
    await pause(15000);
    const quiet = report.updates.filter(update => update.at >= quietFrom && update.track !== undefined);
    step('quiet 15 s', { updates: quiet.length, reasons: quiet.map(update => update.reason) });

    await command('seek to 30 s', { endpoint: 'seek_to', value: 30000 });
    await pause(2000);
    await command('pause', { endpoint: 'pause' });
    await pause(2000);
    await command('resume', { endpoint: 'resume' });
    await pause(3000);
    const onLast = await command('skip_next', { endpoint: 'skip_next' });
    await pause(2000);
    // What plays once the list is over: seek close to the end of the last track and watch.
    const duration = onLast?.duration ?? latest?.player_state?.duration;
    if (duration) {
        await command('seek near the end of the last track', { endpoint: 'seek_to', value: Math.max(0, Number(duration) - 6000) });
        const endFrom = since();
        await pause(20000);
        const after = report.updates.filter(update => update.at >= endFrom && update.track !== undefined);
        step('after the list ended', { tracks: [...new Set(after.map(update => update.track))], last: after.at(-1) ?? null });
    }
    await command('pause at the end', { endpoint: 'pause' });

    clearInterval(pinger);
    socket.close();
}

try {
    await main();
} catch (error) {
    step('failed', { error: String(error?.message ?? error) });
    process.exitCode = 1;
} finally {
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[Probe] Report written to ${REPORT_PATH}`);
    // The dealer socket or a timer may still hold the loop.
    setTimeout(() => process.exit(), 500).unref();
}
