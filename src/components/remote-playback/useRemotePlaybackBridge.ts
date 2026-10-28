import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { NextTrackOptions } from '../../types/appPlayback';
import { omni } from '../../services/onlineMusic/omni';
import { installRemotePlayback, setRemoteEndedHandler, useRemoteTrackStore } from '../../services/remotePlayback/remotePlayback';
import type { RemoteNotice } from '../../services/remotePlayback/remoteTrackStore';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { openSettings } from '../../stores/useSettingsModalStore';

// src/components/remote-playback/useRemotePlaybackBridge.ts
// The remote route's wiring on the React side (the route itself is src/services/remotePlayback/):
// installs it, goes on to the next song when the platform's app reaches the end of one, and tells
// the listener what the route reports (that the platform's app took over, that it could not play).

type UseRemotePlaybackBridgeParams = {
    handleNextTrack: (options?: NextTrackOptions) => Promise<void> | void;
};

// How long the notice that the app took over stays: it says what changes for these songs.
const ENGAGED_NOTICE_MS = 9000;

// Mounted once, in App.
export function useRemotePlaybackBridge({ handleNextTrack }: UseRemotePlaybackBridgeParams) {
    const { t } = useTranslation();
    const latestRef = useRef({ handleNextTrack, t });
    useEffect(() => {
        latestRef.current = { handleNextTrack, t };
    });

    useEffect(() => {
        installRemotePlayback();
        // As <audio>'s onEnded: the next song, or a stop at the end of the queue.
        setRemoteEndedHandler(() => {
            void Promise.resolve(latestRef.current.handleNextTrack({ allowStopOnMissing: true, shouldNavigateToPlayer: false }))
                .catch(error => console.warn('[RemotePlayback] Moving on after the end failed', error));
        });
        const tell = (notice: RemoteNotice) => {
            const { t: translate } = latestRef.current;
            const provider = omni.getProviderLabel(notice.providerId);
            const providerId = notice.providerId;
            if (notice.kind === 'engaged') {
                setStatusMessage({
                    type: 'info', providerId, durationMs: ENGAGED_NOTICE_MS,
                    text: translate('remotePlayback.engaged', { provider }), note: translate('remotePlayback.engagedNote'),
                    // Where it can be turned off, or back to Folia's own playback for this run.
                    actionLabel: translate('remotePlayback.openSettings'),
                    onAction: () => {
                        setStatusMessage(null);
                        openSettings('options', 'playback', null, 'remotePlayback');
                    },
                });
            } else if (notice.kind === 'failed') {
                setStatusMessage({ type: 'error', providerId, text: translate(`remotePlayback.failed.${notice.failure ?? 'refused'}`, { provider }) });
            } else {
                setStatusMessage({ type: 'info', providerId, text: translate(`remotePlayback.${notice.kind}`, { provider }) });
            }
        };
        // The notice that a service's app took over waits until that app plays the song: it comes in the
        // middle of the song's start, whose own messages (loading, matching lyrics) would replace it at once.
        let waitingEngaged: RemoteNotice | null = null;
        const take = (notice: RemoteNotice) => {
            if (notice.kind === 'engaged') waitingEngaged = notice;
            else tell(notice);
        };
        // The restore at start can turn the route on before this subscribes: what it said is taken up here.
        const said = useRemoteTrackStore.getState().notice;
        if (said) take(said);
        const unsubscribe = useRemoteTrackStore.subscribe((state, previous) => {
            if (state.notice && state.notice !== previous.notice) take(state.notice);
            if (waitingEngaged && state.holding && state.current?.providerId === waitingEngaged.providerId) {
                const notice = waitingEngaged;
                waitingEngaged = null;
                tell(notice);
            }
        });
        return () => {
            unsubscribe();
            setRemoteEndedHandler(null);
        };
    }, []);
}
