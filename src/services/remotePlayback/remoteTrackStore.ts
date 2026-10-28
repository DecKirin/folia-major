import { create } from 'zustand';
import type { SongResult } from '../../types';
import type { OnlineProviderId, RemotePlayerFailureKind, RemotePlayerState } from '../../types/onlineMusic';

// src/services/remotePlayback/remoteTrackStore.ts
// The song a platform's own app plays for this one, what the app last reported, the platforms whose
// app plays in this run, and what the listener is to be told (read by useRemotePlaybackBridge).

export type RemoteTrack = {
    trackKey: string;
    songKey: string;
    providerId: OnlineProviderId;
    song: SongResult;
    /** The platform's id of the song, as the app reports it. */
    mediaId: string;
};

/**
 * What the listener is told. `engaged`: the platform's app plays its songs from now on in this run;
 * `failed`: the app could not take a request; `elsewhere`: the app left the song (another song or
 * device). `id` grows, so the same notice twice is told twice.
 */
export type RemoteNotice = {
    id: number;
    kind: 'engaged' | 'failed' | 'elsewhere';
    providerId: OnlineProviderId;
    failure?: RemotePlayerFailureKind;
};

export type RemoteTrackStoreState = {
    current: RemoteTrack | null;
    /** The app has played the current song for this one (since it was started here). */
    holding: boolean;
    /** A request to play is under way. */
    starting: boolean;
    /** What the app reported last; null while it cannot be reached. */
    reported: RemotePlayerState | null;
    /** The platforms whose app plays their songs in this run (remoteRoute.ts). */
    engaged: OnlineProviderId[];
    notice: RemoteNotice | null;
};

export const useRemoteTrackStore = create<RemoteTrackStoreState>(() => ({
    current: null,
    holding: false,
    starting: false,
    reported: null,
    engaged: [],
    notice: null,
}));

let noticeCount = 0;

export const tellRemoteNotice = (notice: Omit<RemoteNotice, 'id'>) => {
    noticeCount += 1;
    useRemoteTrackStore.setState({ notice: { ...notice, id: noticeCount } });
};
