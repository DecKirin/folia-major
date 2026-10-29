import { OnlineProviderError } from '../../../types/onlineMusic';
import type { OnlineRemotePlayer, RemotePlayerFailureKind } from '../../../types/onlineMusic';
import { getSpotifyTransportAvailability, requestSpotify } from './spotifyTransport';
import type { SpotifyWireRemoteState } from './spotifyTransport';
import { requireSpotifySong } from './spotifyNormalize';

// src/services/onlineMusic/spotify/spotifyRemotePlayer.ts
// Spotify's own desktop app playing a Spotify song in the app's place, steered through Spotify
// Connect by the desktop side (electron/spotify/remote.cjs). For an account Spotify gives no audio
// key to, and for a system the playback component has no build for: neither changes from one song
// to the next, so the app takes over. Not a free account: Spotify Connect does not let one be
// steered like this, so it keeps the "Premium only" failure it had.

// The desktop side's sentences for the cases of `takesOver` (electron/spotify/audio.cjs) and of
// `failureKind` (electron/spotify/remote.cjs).
const ACCOUNT_GETS_NO_KEY = 'Spotify gives this account no audio key';
const NO_PLAYBACK_COMPONENT = 'Spotify playback is not available on this system';
const APP_MISSING = 'The Spotify app is not installed on this computer';
const APP_NOT_FOUND = 'The Spotify app on this computer is not playing for this account';

export const spotifyRemotePlayer: OnlineRemotePlayer = {
    takesOver(error) {
        if (!(error instanceof OnlineProviderError) || error.providerId !== 'spotify') return false;
        if (!getSpotifyTransportAvailability().configured) return false;
        return error.message === ACCOUNT_GETS_NO_KEY || error.message === NO_PLAYBACK_COMPONENT;
    },
    async play(song, positionMs) {
        await requestSpotify('remote_play', { id: requireSpotifySong(song), positionMs: Math.max(0, Math.round(positionMs)) });
    },
    async control(action, value) {
        await requestSpotify('remote_control', { action, ...(value === undefined ? {} : { value }) });
    },
    async waitState(after) {
        const state = await requestSpotify<SpotifyWireRemoteState>('remote_state', after === null ? {} : { after });
        const { trackId, ...rest } = state;
        return { ...rest, mediaId: trackId };
    },
    failureKind(error): RemotePlayerFailureKind {
        if (!(error instanceof OnlineProviderError)) return 'refused';
        if (error.message === APP_MISSING) return 'app-missing';
        if (error.message === APP_NOT_FOUND) return 'app-not-found';
        return error.code === 'network' ? 'unreachable' : 'refused';
    },
    async release() {
        await requestSpotify('remote_stop');
    },
};
