import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// test/unit/spotify/spotifyRemote.test.ts — Spotify's own desktop app steered through Spotify
// Connect (electron/spotify/remote.cjs) against a stand-in for Spotify: which device is this
// computer's app, what the play command carries, and what the renderer is told. The shapes are the
// ones the probe measured on 2026-10-27 (test/manual/spotifyRemoteProbe.mjs); the play command is the
// one measured on 2026-10-29 with the app at 1.3.6.

const require = createRequire(import.meta.url);
const { APP_DID_NOT_PLAY, APP_MISSING, APP_NOT_FOUND, createSpotifyRemote, stateOf } = require('../../../electron/spotify/remote.cjs');
const { readPayload } = require('../../../electron/spotify/dealer.cjs');

const TRACK = '3n3Ppam7vgaVa1iaRUc9Lp';
const HERE = { device_id: 'here000000000000000000000000000000000001', name: 'Xiding\'s MacBook Pro', device_type: 'COMPUTER', volume: 32767.5 };
const OTHER = { device_id: 'other00000000000000000000000000000000002', name: 'XIDINGSDESKTOP', device_type: 'COMPUTER' };
const PHONE = { device_id: 'phone00000000000000000000000000000000003', name: 'iPhone', device_type: 'SMARTPHONE' };

const clusterOf = (devices: object[], player: Record<string, unknown> = {}, active: string | null = null) => ({
    active_device_id: active,
    devices: Object.fromEntries(devices.map(device => [(device as { device_id: string }).device_id, device])),
    player_state: player,
});

// A stand-in for spclient: answers registration with `cluster()` and records every request.
const fakeSpotify = ({ cluster, command = () => ({ status: 200, body: { ack_id: 'a' } }) }: {
    cluster: () => object;
    command?: (path: string, body: any) => { status: number; body: unknown };
}) => {
    const requests: Array<{ method: string; path: string; body: any }> = [];
    const fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
        const { pathname } = new URL(url);
        if (url.startsWith('https://apresolve.spotify.com')) {
            return { ok: true, status: 200, json: async () => ({ dealer: ['gue1-dealer.spotify.com:443'], spclient: ['gue1-spclient.spotify.com:443'] }) };
        }
        const body = init.body ? JSON.parse(init.body) : undefined;
        requests.push({ method: init.method ?? 'GET', path: pathname, body });
        const answer = pathname.startsWith('/connect-state/v1/devices/') ? { status: 200, body: cluster() } : command(pathname, body);
        return { ok: answer.status < 300, status: answer.status, text: async () => JSON.stringify(answer.body) };
    };
    return { fetch, requests, cluster };
};

// `appPlays`: the app takes up a play it is sent and reports the track as its own, as Spotify's does;
// without it the app is sent the play and reports nothing.
const remoteWith = (spotify: ReturnType<typeof fakeSpotify>, options: Record<string, unknown> = {}, { appPlays = true } = {}) => {
    const pushes: Array<(cluster: object) => void> = [];
    const push = (cluster: object) => pushes.forEach(onCluster => onCluster(cluster));
    const fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
        const answer = await spotify.fetch(url, init);
        const command = init.body ? JSON.parse(init.body).command : undefined;
        if (appPlays && answer.ok && command?.endpoint === 'play') {
            const target = url.slice(url.lastIndexOf('/') + 1);
            push({ ...spotify.cluster(), active_device_id: target, player_state: { track: { uri: command.context.uri }, is_playing: true, is_paused: false } });
        }
        return answer;
    };
    const remote = createSpotifyRemote({
        accessToken: async () => 'token', fetch, log: () => {}, warn: () => {},
        names: async () => ['Xiding\'s MacBook Pro', 'Mac'],
        openDealer: async ({ onCluster }: { onCluster: (cluster: object) => void }) => {
            pushes.push(onCluster);
            return { connectionId: 'connection', close: () => {} };
        },
        wait: async () => {},
        ...options,
    });
    return { remote, push };
};

describe('stateOf', () => {
    it('reads the account\'s state as it concerns this computer\'s app', () => {
        const state = stateOf(clusterOf([HERE], {
            track: { uri: `spotify:track:${TRACK}` }, is_paused: false, is_playing: true,
            position_as_of_timestamp: '30000', timestamp: '1793150705923', duration: '222973',
        }, HERE.device_id), HERE, () => 0);
        expect(state).toEqual({
            connected: true, deviceName: HERE.name, active: true, trackId: TRACK, paused: false,
            positionMs: 30000, positionAtMs: 1793150705923, durationMs: 222973, volume: 0.5,
        });
    });

    it('takes a state not yet started (playing and paused at once) as paused', () => {
        expect(stateOf(clusterOf([HERE], { is_paused: true, is_playing: true }), HERE, () => 0).paused).toBe(true);
    });
});

describe('readPayload', () => {
    it('reads an object, base64 JSON and gzipped base64 JSON, and leaves anything else', () => {
        const value = { cluster: { active_device_id: 'x' } };
        expect(readPayload(value)).toBe(value);
        expect(readPayload(Buffer.from(JSON.stringify(value)).toString('base64'))).toEqual(value);
        expect(readPayload(gzipSync(Buffer.from(JSON.stringify(value))).toString('base64'))).toEqual(value);
        expect(readPayload(Buffer.from([8, 1, 18, 0]).toString('base64'))).toBeNull();
    });
});

describe('createSpotifyRemote', () => {
    it('plays one track on this computer\'s app, found by the computer\'s name among the account\'s computers', async () => {
        const spotify = fakeSpotify({ cluster: () => clusterOf([OTHER, HERE, PHONE]) });
        const { remote } = remoteWith(spotify);
        await remote.play({ trackId: TRACK, positionMs: 0 });
        const commands = spotify.requests.filter(request => request.method === 'POST');
        expect(commands).toHaveLength(1);
        expect(commands[0].path).toMatch(new RegExp(`/connect-state/v1/player/command/from/hobs_[0-9a-f]{40}/to/${HERE.device_id}$`));
        // The track as its own context: one that names no uri is taken and dropped by the app.
        expect(commands[0].body.command).toMatchObject({
            endpoint: 'play',
            context: { uri: `spotify:track:${TRACK}`, url: `context://spotify:track:${TRACK}` },
            options: {},
        });
        expect(commands[0].body.command.context.pages).toBeUndefined();
    });

    it('opens the app where the account lists no computer of this one, and takes the computer that joins as it', async () => {
        let joined = false;
        const renamed = { ...HERE, name: 'spotify-linux' };
        const spotify = fakeSpotify({ cluster: () => clusterOf(joined ? [OTHER, renamed] : [OTHER]) });
        let opened = 0;
        const { remote } = remoteWith(spotify, { openApp: async () => { opened += 1; joined = true; return true; } });
        await remote.play({ trackId: TRACK });
        expect(opened).toBe(1);
        expect(spotify.requests.find(request => request.method === 'POST')?.path).toMatch(new RegExp(`/to/${HERE.device_id}$`));
    });

    it('never plays on another computer of the account', async () => {
        const spotify = fakeSpotify({ cluster: () => clusterOf([OTHER]) });
        const { remote } = remoteWith(spotify, { openApp: async () => true });
        await expect(remote.play({ trackId: TRACK })).rejects.toMatchObject({ code: 'unavailable', message: APP_NOT_FOUND });
        expect(spotify.requests.some(request => request.method === 'POST')).toBe(false);
    });

    it('says the app is missing where the system could not open one', async () => {
        const spotify = fakeSpotify({ cluster: () => clusterOf([]) });
        const { remote } = remoteWith(spotify, { openApp: async () => false });
        await expect(remote.play({ trackId: TRACK })).rejects.toMatchObject({ message: APP_MISSING });
    });

    it('takes a pause of what is paused as done, and a device that is gone as the app not found', async () => {
        const answers = [{ status: 403, body: { error_description: 'pause_restricted', reasons: ['already_paused'] } }, { status: 404, body: {} }];
        const spotify = fakeSpotify({ cluster: () => clusterOf([HERE]), command: () => answers.shift()! });
        const { remote } = remoteWith(spotify);
        await expect(remote.control({ action: 'pause' })).resolves.toBeUndefined();
        await expect(remote.control({ action: 'resume' })).rejects.toMatchObject({ message: APP_NOT_FOUND });
    });

    it('starts the track where it was asked to start, in the one command', async () => {
        const spotify = fakeSpotify({ cluster: () => clusterOf([HERE]) });
        const { remote } = remoteWith(spotify);
        await remote.play({ trackId: TRACK, positionMs: 61000 });
        const commands = spotify.requests.filter(request => request.method === 'POST').map(request => request.body.command);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({ endpoint: 'play', options: { seek_to: 61000 } });
    });

    it('fails a play that Spotify answers but the app does not take up', async () => {
        const spotify = fakeSpotify({ cluster: () => clusterOf([HERE]) });
        const { remote } = remoteWith(spotify, {}, { appPlays: false });
        await expect(remote.play({ trackId: TRACK })).rejects.toMatchObject({ code: 'unavailable', message: APP_DID_NOT_PLAY });
    });

    it('does not take a report from before the play, of the same track, as the play done', async () => {
        const already = clusterOf([HERE], { track: { uri: `spotify:track:${TRACK}` }, is_playing: true, is_paused: false }, HERE.device_id);
        const spotify = fakeSpotify({ cluster: () => already });
        const { remote } = remoteWith(spotify, {}, { appPlays: false });
        await expect(remote.play({ trackId: TRACK })).rejects.toMatchObject({ message: APP_DID_NOT_PLAY });
    });

    it('answers the state at once without a version, and waits for a newer one with it', async () => {
        const spotify = fakeSpotify({ cluster: () => clusterOf([HERE]) });
        const { remote, push } = remoteWith(spotify);
        const first = await remote.waitState({});
        expect(first).toMatchObject({ connected: true, deviceName: HERE.name, active: false });
        const next = remote.waitState({ after: first.version });
        push(clusterOf([HERE], { track: { uri: `spotify:track:${TRACK}` }, is_playing: true, is_paused: false }, HERE.device_id));
        await expect(next).resolves.toMatchObject({ version: first.version + 1, active: true, trackId: TRACK, paused: false });
    });

    it('rejects a track id that is not one', async () => {
        const { remote } = remoteWith(fakeSpotify({ cluster: () => clusterOf([HERE]) }));
        await expect(remote.play({ trackId: '../../x' })).rejects.toMatchObject({ code: 'invalid-response' });
    });
});
