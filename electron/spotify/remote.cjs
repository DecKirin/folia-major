const crypto = require('node:crypto');
const { openSpotifyDealer } = require('./dealer.cjs');
const { computerNames, openSpotifyApp } = require('./desktopApp.cjs');
const { spotifyError, statusError } = require('./errors.cjs');

// electron/spotify/remote.cjs
// Spotify's own desktop app playing a song for the app, steered through Spotify Connect: for an
// account Spotify gives no audio key to (or a system without the playback component), the app on
// this computer plays and Folia shows and steers it. No audio passes through here.
// Measured 2026-10-27 with this sign-in (test/manual/spotifyRemoteProbe.mjs): a hidden observer
// (`hobs_<id>`) registered with the dealer's connection id is answered the account's whole state
// as JSON, and every change after that is pushed; `play` of a list of tracks given inline starts
// at the track `skip_to` names; pause, resume and seek are acted on in about 0.2 s. The position
// is pushed only when it changes course: the renderer counts it on from `positionAtMs`. When the
// list is over the app goes back to its first track and stops there; nothing else plays.

const RESOLVE_URL = 'https://apresolve.spotify.com/?type=dealer&type=spclient';
const FALLBACK_HOSTS = Object.freeze({ dealer: 'dealer.spotify.com', spclient: 'spclient.wg.spotify.com' });
// A request that is not answered in this time has failed.
const REQUEST_LIMIT_MS = 15 * 1000;
// After the app was opened, the account's devices are read this often, for this long, until it is there.
const APP_POLL_MS = 2000;
const APP_WAIT_MS = 25 * 1000;
// A started track is waited for this long before a position to start at is sought.
const START_WAIT_MS = 6000;
// The longest a wait for news holds the renderer's request.
const WAIT_LIMIT_MS = 20 * 1000;
// After a failed connection the next is not tried sooner than this.
const RECONNECT_AFTER_MS = 5000;
const TRACK_ID = /^[0-9A-Za-z]{22}$/;
// The sentences the renderer tells the cases apart by (src/services/onlineMusic/spotify/spotifyRemotePlayer.ts).
const APP_MISSING = 'The Spotify app is not installed on this computer';
const APP_NOT_FOUND = 'The Spotify app on this computer is not playing for this account';

const EMPTY_STATE = Object.freeze({
  connected: false, deviceName: null, active: false, trackId: null, paused: true, positionMs: 0, positionAtMs: 0, durationMs: null, volume: null,
});

const computersOf = cluster => Object.values(cluster?.devices ?? {}).filter(device => typeof device?.device_id === 'string'
  && !device.device_id.startsWith('hobs_') && String(device.device_type).toUpperCase() === 'COMPUTER');

// What the renderer is told of the account's state, as far as it concerns the app on this computer.
function stateOf(cluster, device, now) {
  const player = cluster?.player_state ?? {};
  const uri = typeof player.track?.uri === 'string' ? player.track.uri : '';
  const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    connected: true,
    deviceName: device ? String(device.name ?? '') : null,
    active: Boolean(device) && cluster?.active_device_id === device.device_id,
    trackId: /^spotify:track:([0-9A-Za-z]{22})$/.exec(uri)?.[1] ?? null,
    // A state not yet started reads `is_playing` true and `is_paused` true together.
    paused: player.is_paused === true || player.is_playing !== true,
    positionMs: number(player.position_as_of_timestamp) ?? 0,
    positionAtMs: number(player.timestamp) ?? now(),
    durationMs: number(player.duration),
    // The app's volume, 0 to 1 (Spotify counts it to 65535); null where the account does not say.
    volume: number(device?.volume) === null ? null : Math.min(1, Math.max(0, number(device.volume) / 65535)),
  };
}

// `accessToken(fresh)` resolves to the account's token, a renewed one where `fresh`;
// `openExternal` opens a `spotify:` link (the app on Windows).
function createSpotifyRemote({
  accessToken, fetch, openExternal, now = Date.now, log = (...args) => console.log(...args), warn = (...args) => console.warn(...args),
  openDealer = openSpotifyDealer, openApp = () => openSpotifyApp({ openExternal }), names = () => computerNames(),
  wait = ms => new Promise(resolve => { setTimeout(resolve, ms); }),
}) {
  const observer = `hobs_${crypto.randomBytes(20).toString('hex')}`;
  let session = null;
  let connecting = null;
  let failedAt = 0;
  let cluster = null;
  // The app on this computer once it was found, kept for the run: its name may not be the computer's.
  let deviceId = null;
  let ownNames = null;
  let state = { ...EMPTY_STATE };
  let version = 0;
  const waiters = new Set();

  const publish = next => {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    version += 1;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const device = () => {
    const computers = computersOf(cluster);
    const kept = computers.find(candidate => candidate.device_id === deviceId);
    if (kept) return kept;
    const lower = (ownNames ?? []).map(name => name.toLowerCase());
    const named = computers.find(candidate => lower.includes(String(candidate.name ?? '').toLowerCase()));
    if (named) {
      deviceId = named.device_id;
      log(`[SpotifyRemote] The app on this computer is "${named.name}"`);
    }
    return named ?? null;
  };
  const apply = next => {
    cluster = next;
    publish(stateOf(cluster, device(), now));
  };

  // One request to spclient as the account; a 401 is answered once with a renewed token.
  const send = async (method, path, body, headers = {}) => {
    const host = session?.spclient ?? FALLBACK_HOSTS.spclient;
    const ask = async token => fetch(`https://${host}${path}`, {
      method, signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers, Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let response = await ask(await accessToken());
    if (response.status === 401) response = await ask(await accessToken(true));
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: response.status, ok: response.ok, json, text: json ? '' : text.slice(0, 160) };
  };
  const register = async () => {
    const answer = await send('PUT', `/connect-state/v1/devices/${observer}`, {
      member_type: 'CONNECT_STATE',
      device: { device_info: { capabilities: { can_be_player: false, hidden: true, needs_full_player_state: true } } },
    }, { 'X-Spotify-Connection-Id': session.connectionId });
    if (!answer.ok || !answer.json) throw statusError(answer.status, 'unavailable', 'Spotify Connect refused the app', `register: HTTP ${answer.status}`);
    apply(answer.json);
  };

  const hosts = async () => {
    try {
      const answer = await (await fetch(RESOLVE_URL, { signal: AbortSignal.timeout(REQUEST_LIMIT_MS) })).json();
      const first = list => (Array.isArray(list) && typeof list[0] === 'string' ? list[0].replace(/:443$/, '') : null);
      return { dealer: first(answer?.dealer) ?? FALLBACK_HOSTS.dealer, spclient: first(answer?.spclient) ?? FALLBACK_HOSTS.spclient };
    } catch {
      return { ...FALLBACK_HOSTS };
    }
  };
  // Connected and registered, once for all callers; a failure is not tried again for a while.
  const ensure = () => {
    if (session) return Promise.resolve();
    if (connecting) return connecting;
    if (now() - failedAt < RECONNECT_AFTER_MS) return Promise.reject(spotifyError('network', 'Spotify Connect could not be reached'));
    const attempt = (async () => {
      ownNames ??= await names();
      const { dealer: host, spclient } = await hosts();
      // Pushes and a close are taken only from the socket of the session that is open.
      let dealer = null;
      const owns = () => dealer !== null && session?.dealer === dealer;
      dealer = await openDealer({
        host, accessToken: await accessToken(),
        onCluster: next => { if (owns()) apply(next); },
        onClose: reason => {
          if (!owns()) return;
          warn(`[SpotifyRemote] The connection to Spotify Connect ${reason}`);
          session = null;
          publish({ ...EMPTY_STATE });
        },
      }).catch(error => {
        throw spotifyError('network', 'Spotify Connect could not be reached', error?.message);
      });
      session = { dealer, connectionId: dealer.connectionId, spclient };
      try {
        await register();
      } catch (error) {
        session = null;
        dealer.close();
        throw error;
      }
      log(`[SpotifyRemote] Connected to Spotify Connect (${computersOf(cluster).length} computers on the account, ${device() ? 'this one among them' : 'not this one'})`);
    })().catch(error => {
      failedAt = now();
      throw error;
    }).finally(() => { connecting = null; });
    connecting = attempt;
    return attempt;
  };

  // The app on this computer, opened and waited for where the account does not list it.
  const reachApp = async () => {
    await ensure();
    const found = device();
    if (found) return found;
    const before = new Set(computersOf(cluster).map(candidate => candidate.device_id));
    if (!await openApp()) throw spotifyError('unavailable', APP_MISSING);
    log('[SpotifyRemote] The Spotify app was opened; waiting for it to join the account');
    for (let waited = 0; waited < APP_WAIT_MS; waited += APP_POLL_MS) {
      await wait(APP_POLL_MS);
      if (!session) await ensure();
      await register();
      // A computer that joined after the app was opened is the app on this one, whatever its name.
      const joined = device() ?? computersOf(cluster).find(candidate => !before.has(candidate.device_id));
      if (joined) {
        deviceId = joined.device_id;
        apply(cluster);
        log(`[SpotifyRemote] The app joined as "${joined.name}" after ${waited + APP_POLL_MS} ms`);
        return joined;
      }
    }
    throw spotifyError('unavailable', APP_NOT_FOUND, 'not listed among the account\'s devices');
  };

  // One player command to the app. A pause of what is paused (or the like) is no failure.
  const command = async (target, body) => {
    const answer = await send('POST', `/connect-state/v1/player/command/from/${observer}/to/${target.device_id}`, {
      command: { ...body, logging_params: { command_id: crypto.randomBytes(16).toString('hex') } },
    });
    if (answer.ok) return;
    const reasons = Array.isArray(answer.json?.reasons) ? answer.json.reasons : [];
    if (answer.status === 403 && reasons.some(reason => /^already_|^not_paused|^not_playing/.test(String(reason)))) return;
    if (answer.status === 404) {
      deviceId = null;
      throw spotifyError('unavailable', APP_NOT_FOUND, `${body.endpoint}: HTTP 404`);
    }
    throw statusError(answer.status, 'unavailable', 'Spotify Connect refused the command',
      `${body.endpoint}: HTTP ${answer.status} ${answer.json?.error_description ?? answer.text}`);
  };

  return {
    // Plays one track in the app from `positionMs`: the list given holds this track only, so when
    // it ends the app stops on it and the renderer goes on to its own next song.
    async play({ trackId, positionMs = 0 }) {
      if (typeof trackId !== 'string' || !TRACK_ID.test(trackId)) throw spotifyError('invalid-response', 'Invalid Spotify track');
      const target = await reachApp();
      const uri = `spotify:track:${trackId}`;
      await command(target, {
        endpoint: 'play',
        context: { uri: '', url: '', pages: [{ tracks: [{ uri }] }] },
        play_origin: { feature_identifier: 'folia', feature_version: 'remote' },
        options: { skip_to: { track_uri: uri, track_index: 0 } },
      });
      const from = Math.max(0, Math.round(Number(positionMs) || 0));
      log(`[SpotifyRemote] ${trackId} was started in the app${from > 0 ? ` (from ${from} ms)` : ''}`);
      if (from < 1000) return;
      // The track is sought once the app holds it: a seek sent before it is loaded is lost.
      for (let waited = 0; waited < START_WAIT_MS && !(state.trackId === trackId && state.active); waited += 250) await wait(250);
      await command(target, { endpoint: 'seek_to', value: from });
    },

    async control({ action, value }) {
      if (!['pause', 'resume', 'seek', 'volume'].includes(action)) throw spotifyError('invalid-response', 'Invalid Spotify remote action');
      await ensure();
      const target = device();
      if (!target) throw spotifyError('unavailable', APP_NOT_FOUND);
      if (action === 'seek') {
        await command(target, { endpoint: 'seek_to', value: Math.max(0, Math.round(Number(value) || 0)) });
      } else if (action === 'volume') {
        const level = Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 65535);
        const answer = await send('PUT', `/connect-state/v1/connect/volume/from/${observer}/to/${target.device_id}`, { volume: level });
        if (!answer.ok) throw statusError(answer.status, 'unavailable', 'Spotify Connect refused the command', `volume: HTTP ${answer.status}`);
      } else {
        await command(target, { endpoint: action });
      }
    },

    // The state once it is newer than version `after` (at once where it is, or where `after` is
    // not a number), or as it is after WAIT_LIMIT_MS. Connects first where it is not connected.
    async waitState({ after } = {}) {
      await ensure();
      if (typeof after === 'number' && after >= version) {
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            waiters.delete(done);
            resolve();
          }, WAIT_LIMIT_MS);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          waiters.add(done);
        });
      }
      return { ...state, version };
    },

    // Leaves Spotify Connect: the socket is closed. The app itself goes on as it was.
    stop() {
      const open = session;
      session = null;
      cluster = null;
      if (open) {
        open.dealer.close();
        log('[SpotifyRemote] Left Spotify Connect');
      }
      publish({ ...EMPTY_STATE });
    },
  };
}

module.exports = { APP_MISSING, APP_NOT_FOUND, createSpotifyRemote, stateOf };
