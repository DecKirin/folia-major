import { useMemo } from 'react';
import type { SongResult, StageLoopMode } from '../../types';
import type { PlaybackRoute } from '../../types/hifi';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useRemotePlaybackSettingsStore } from '../../stores/useRemotePlaybackSettingsStore';
import { remoteRouteFor } from '../../services/remotePlayback/remoteRoute';
import { useRemoteTrackStore } from '../../services/remotePlayback/remoteTrackStore';
import { nextQueueIndex, queueIndexOf, queueLoopMode } from '../../utils/playbackNeighbors';

// src/components/remote-playback/useRemoteAutomixGate.ts
// A transition (automix, crossfade) sounds two of Folia's own decks at once; a platform's own app is
// neither of them. Off while the song or the next one plays in such an app, as useHifiAutomixGate
// does for mpv.

export type RemoteAutomixGateInput = {
    playbackRoute: PlaybackRoute;
    playQueue: SongResult[];
    currentSong: SongResult | null;
    loopMode: StageLoopMode;
    isFmMode: boolean;
};

/** Whether the remote route blocks a transition: on it now, or the song or the next one (handleNextTrack's rule) would go there. */
export const remoteBlocksAutomix = (
    { playbackRoute, playQueue, currentSong, loopMode, isFmMode }: RemoteAutomixGateInput,
    routeFor: (song: SongResult | null | undefined) => boolean = remoteRouteFor,
): boolean => {
    if (playbackRoute === 'remote') return true;
    if (routeFor(currentSong)) return true;
    const nextIndex = nextQueueIndex(playQueue.length, queueIndexOf(playQueue, currentSong), queueLoopMode(loopMode, isFmMode));
    return nextIndex >= 0 && routeFor(playQueue[nextIndex]);
};

// App folds it into useAutomixDecks' isEnabled.
export function useRemoteAutomixGate(): boolean {
    const playbackRoute = usePlaybackStore(state => state.playbackRoute);
    const playQueue = usePlaybackStore(state => state.playQueue);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    const loopMode = useAudioSettingsStore(state => state.loopMode);
    // remoteRouteFor reads these itself; they are subscribed to so that the gate is asked again when they change.
    const enabled = useRemotePlaybackSettingsStore(state => state.enabled);
    const engaged = useRemoteTrackStore(state => state.engaged);

    return useMemo(
        () => remoteBlocksAutomix({ playbackRoute, playQueue, currentSong, loopMode, isFmMode }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [currentSong, enabled, engaged, isFmMode, loopMode, playQueue, playbackRoute],
    );
}
