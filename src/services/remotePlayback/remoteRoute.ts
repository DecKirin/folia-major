import type { SongResult } from '../../types';
import type { OmniRemotePlayer, OnlineProviderId } from '../../types/onlineMusic';
import { useRemotePlaybackSettingsStore } from '../../stores/useRemotePlaybackSettingsStore';
import { getOnlineProviderIdForSong, getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { omni } from '../onlineMusic/omni';
import { tellRemoteNotice, useRemoteTrackStore } from './remoteTrackStore';

// src/services/remotePlayback/remoteRoute.ts
// Whether a song plays in its platform's own app (the remote route) instead of in Folia. Only a song
// of a platform that has such an app (`omni.getRemotePlayer`) ever does, and only:
//   - 'always': every song of that platform;
//   - 'auto' (the default): once, in this run, the platform said this account's audio will not play
//     in Folia at all (`OnlineRemotePlayer.takesOver`), from then on until the app is closed;
//   - 'off': never.
// Every other song (local, Navidrome, other platforms) is not touched by any of this.

export type RemotePlayerOfSong = { providerId: OnlineProviderId; player: OmniRemotePlayer; mediaId: string };

/** The app that would play `song` in Folia's place, or null where its platform has none. */
export const remotePlayerOf = (song: SongResult | null | undefined): RemotePlayerOfSong | null => {
    const providerId = getOnlineProviderIdForSong(song);
    if (!song || !providerId) return null;
    const player = omni.getRemotePlayer(providerId);
    const source = getPlaybackSourceRef(song);
    if (!player || source.kind !== 'online') return null;
    return { providerId, player, mediaId: String(source.mediaId) };
};

export const remoteRouteFor = (song: SongResult | null | undefined): boolean => {
    const mode = useRemotePlaybackSettingsStore.getState().mode;
    const { engaged } = useRemoteTrackStore.getState();
    // The common case, asked on every start of a song: nothing has turned the route on.
    if (mode === 'off' || (mode === 'auto' && engaged.length === 0)) return false;
    const found = remotePlayerOf(song);
    if (!found) return false;
    return mode === 'always' || engaged.includes(found.providerId);
};

/**
 * A request for `song`'s audio failed with `error`. Where its platform's app takes over for such a
 * failure, the platform's songs play in the app from now on in this run, and the listener is told
 * (once). Answers whether the song is now to play in the app.
 */
export const noteRemoteTakeover = (song: SongResult, error: unknown): boolean => {
    if (useRemotePlaybackSettingsStore.getState().mode === 'off') return false;
    const found = remotePlayerOf(song);
    if (!found || !found.player.takesOver(error)) return false;
    const { engaged } = useRemoteTrackStore.getState();
    if (engaged.includes(found.providerId)) return true;
    useRemoteTrackStore.setState({ engaged: [...engaged, found.providerId] });
    console.info(`[RemotePlayback] ${found.providerId}: its songs play in its own app from now on in this run`, error);
    tellRemoteNotice({ kind: 'engaged', providerId: found.providerId });
    return true;
};

/** The platform's songs go back to Folia's own playback for the rest of the run. */
export const disengageRemote = (providerId: OnlineProviderId) => {
    const { engaged } = useRemoteTrackStore.getState();
    if (!engaged.includes(providerId)) return;
    useRemoteTrackStore.setState({ engaged: engaged.filter(id => id !== providerId) });
    console.info(`[RemotePlayback] ${providerId}: its songs play in Folia again`);
};
