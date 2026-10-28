const { gunzipSync } = require('node:zlib');

// electron/spotify/dealer.cjs
// The socket Spotify pushes an account's player state over (its "dealer"), as Spotify's own apps
// keep one. Its first message names the connection id that registering for that state needs;
// after that, the pushes of `hm://connect-state/v1/cluster` are passed on, each as the cluster it
// carries. A ping every 30 s keeps it open (librespot's interval); a socket that closes on its own
// is reported once. Measured 2026-10-27 (test/manual/spotifyRemoteProbe.mjs): the pushes come as
// JSON objects; base64 of JSON, gzipped or not, is read too.

const PING_MS = 30 * 1000;
// The connection id comes in the first message; a socket that has not named one by then has failed.
const CONNECTION_ID_LIMIT_MS = 15 * 1000;
const CLUSTER_URI = 'hm://connect-state/v1/cluster';

// One payload of a push: an object already, or base64 of JSON (gzipped or not). Anything else
// (protobuf, which a hidden observer registered with JSON is not sent) is null.
function readPayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload !== 'string') return null;
  try {
    let bytes = Buffer.from(payload, 'base64');
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    const text = bytes.toString('utf8');
    return text.startsWith('{') ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Opens the socket and resolves once Spotify has named the connection: `{ connectionId, close() }`.
// `onCluster(cluster)` is called for every cluster pushed; `onClose(reason)` once, when the socket
// closes or fails without `close()` having been called.
function openSpotifyDealer({
  host, accessToken, onCluster, onClose, WebSocketImpl = globalThis.WebSocket,
  setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval,
}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocketImpl !== 'function') {
      reject(new Error('WebSocket is not available in this process'));
      return;
    }
    const socket = new WebSocketImpl(`wss://${host}/?access_token=${encodeURIComponent(accessToken)}`);
    let connectionId = null;
    let ended = false;
    let pinger = null;
    const finish = reason => {
      if (ended) return;
      ended = true;
      clearTimer(limit);
      if (pinger !== null) clearRepeat(pinger);
      if (connectionId === null) reject(new Error(`dealer: ${reason}`));
      else onClose?.(reason);
    };
    const limit = setTimer(() => {
      finish('no connection id');
      try { socket.close(); } catch { /* closed already */ }
    }, CONNECTION_ID_LIMIT_MS);

    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message?.type === 'ping') {
        try { socket.send('{"type":"pong"}'); } catch { /* the close below reports it */ }
        return;
      }
      if (message?.type !== 'message') return;
      const named = message.headers?.['Spotify-Connection-Id'];
      if (named && connectionId === null) {
        connectionId = named;
        clearTimer(limit);
        pinger = setRepeat(() => {
          try { socket.send('{"type":"ping"}'); } catch { /* the close below reports it */ }
        }, PING_MS);
        resolve({
          connectionId,
          close() {
            ended = true;
            clearTimer(limit);
            if (pinger !== null) clearRepeat(pinger);
            try { socket.close(); } catch { /* closed already */ }
          },
        });
        return;
      }
      if (!String(message.uri ?? '').startsWith(CLUSTER_URI)) return;
      for (const payload of Array.isArray(message.payloads) ? message.payloads : []) {
        const read = readPayload(payload);
        const cluster = read?.cluster ?? null;
        if (cluster) onCluster?.(cluster);
      }
    });
    socket.addEventListener('close', () => finish('closed'));
    socket.addEventListener('error', () => finish('failed'));
  });
}

module.exports = { openSpotifyDealer, readPayload };
