import { PlayerState } from '../../types';
import type { SongResult } from '../../types';
import type { OmniRemotePlayer, RemotePlayerState } from '../../types/onlineMusic';
import { setAudioSrc, setDuration, setPlaybackRoute, setPlayerState, usePlaybackStore } from '../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { HifiMediaShim, registerRouteMedia } from '../hifi/hifiMediaShim';
import { IDLE_REMOTE_CLOCK, pauseRemoteClock, readRemoteClockMs, readRemoteUpdate, type RemoteClock } from './remoteClock';
import { remotePlayerOf } from './remoteRoute';
import { tellRemoteNotice, useRemoteTrackStore, type RemoteTrack } from './remoteTrackStore';

// src/services/remotePlayback/remotePlayback.ts
// The remote route: a song of a platform whose own desktop app plays it in Folia's place
// (remoteRoute.ts decides which). No audio is in Folia: the app sounds the song, Folia shows it
// (lyrics, cover, progress) from the state the app reports and steers it (play, pause, seek). One
// song is handed to the app at a time; when it ends there, Folia goes on to its own next song,
// which may be anyone's: a song of another platform plays in Folia as always, and the app is
// paused as Folia leaves the route (the route guard below).

// A media element's likeness for the observers that read one (Media Session, listening reports):
// the same class the HiFi route uses, counting from the app's reports.
const remoteMediaShim = new HifiMediaShim(() => getRemotePosition());

let clock: RemoteClock = IDLE_REMOTE_CLOCK;
// Bumped by every start and by leaving the route: an answer that comes back to an older one is dropped.
let attempt = 0;
// Bumped by every start of the state loop and by leaving the route: an older loop stops.
let loop = 0;
// The writes of this module to the playback store, which its own route guard leaves alone.
let ownWriteDepth = 0;
// What Folia does when the app reaches the end of the song (useRemotePlaybackBridge: the next song).
let endedHandler: (() => void) | null = null;
// The song an advertisement was told for: told once a song, not on every report while it plays.
let adToldFor: string | null = null;

const withoutRouteGuard = (write: () => void) => {
    ownWriteDepth += 1;
    try {
        write();
    } finally {
        ownWriteDepth -= 1;
    }
};

const sleep = (ms: number) => new Promise<void>(resolve => { globalThis.setTimeout(resolve, ms); });

export const isRemoteRoute = () => usePlaybackStore.getState().playbackRoute === 'remote';

/** Where the app is in the current song, in seconds, counted on from its last report. */
export const getRemotePosition = () => readRemoteClockMs(clock) / 1000;

export const isRemotePaused = () => clock.paused;

export const setRemoteEndedHandler = (handler: (() => void) | null) => {
    endedHandler = handler;
};

const playerOf = (track: RemoteTrack | null): OmniRemotePlayer | null => remotePlayerOf(track?.song)?.player ?? null;

const showDuration = (durationMs: number | null) => {
    if (durationMs === null || !(durationMs > 0)) return;
    const seconds = durationMs / 1000;
    remoteMediaShim.setDuration(seconds);
    if (usePlaybackStore.getState().duration !== seconds) setDuration(seconds);
};

/** The app could not take a request for `track`: the song stops where it is, and the listener is told why. */
const fail = (track: RemoteTrack, player: OmniRemotePlayer, error: unknown) => {
    const failure = player.failureKind(error);
    console.warn(`[RemotePlayback] The app could not play "${track.song.name}" (${failure})`, error);
    useRemoteTrackStore.setState({ starting: false });
    clock = pauseRemoteClock(clock);
    remoteMediaShim.markPaused();
    setPlayerState(PlayerState.PAUSED);
    tellRemoteNotice({ kind: 'failed', providerId: track.providerId, failure });
};

/** Asks the app to play `track` from `positionMs`. */
const start = async (track: RemoteTrack, positionMs: number) => {
    const player = playerOf(track);
    if (!player) return false;
    const mine = attempt;
    useRemoteTrackStore.setState({ starting: true });
    try {
        await player.play(track.song, positionMs);
        if (mine !== attempt) return false;
        useRemoteTrackStore.setState({ starting: false });
        return true;
    } catch (error) {
        if (mine === attempt) fail(track, player, error);
        return false;
    }
};

/** One report of the app's state, read against the song shown. */
const applyReport = (reported: RemotePlayerState) => {
    useRemoteTrackStore.setState({ reported });
    const { current, holding } = useRemoteTrackStore.getState();
    if (!current || !isRemoteRoute()) return;
    const update = readRemoteUpdate({ mediaId: current.mediaId, holding, clock }, reported);
    if (update.kind === 'waiting') return;
    if (update.kind === 'ad' || update.kind === 'elsewhere') {
        clock = pauseRemoteClock(clock);
        remoteMediaShim.markPaused();
        if (usePlaybackStore.getState().playerState === PlayerState.PLAYING) setPlayerState(PlayerState.PAUSED);
        if (update.kind === 'elsewhere') {
            // Played again from here (a press of play) it is handed to the app anew.
            useRemoteTrackStore.setState({ holding: false });
            console.info('[RemotePlayback] The app left the song for another song or device', { songKey: current.songKey });
        } else if (adToldFor === current.trackKey) {
            return;
        }
        adToldFor = current.trackKey;
        tellRemoteNotice({ kind: update.kind, providerId: current.providerId });
        return;
    }
    if (!holding) useRemoteTrackStore.setState({ holding: true });
    clock = update.clock;
    showDuration(clock.durationMs);
    if (update.ended) {
        console.info('[RemotePlayback] The song ended in the app', { songKey: current.songKey });
        remoteMediaShim.markEnded();
        endedHandler?.();
        return;
    }
    if (update.seeked) remoteMediaShim.markSeeked();
    const playback = usePlaybackStore.getState();
    if (!clock.paused) {
        if (remoteMediaShim.paused) remoteMediaShim.markPlaying();
        if (playback.playerState !== PlayerState.PLAYING || playback.isLoadingToPlay) setPlayerState(PlayerState.PLAYING);
    } else {
        remoteMediaShim.markPaused();
        if (playback.playerState === PlayerState.PLAYING) setPlayerState(PlayerState.PAUSED);
    }
};

/** Follows the app's state for as long as this loop is the latest; a failure is asked again after a wait. */
const runStateLoop = (player: OmniRemotePlayer) => {
    loop += 1;
    const token = loop;
    void (async () => {
        let after: number | null = null;
        let failures = 0;
        while (token === loop) {
            try {
                const reported = await player.waitState(after);
                if (token !== loop) return;
                failures = 0;
                after = reported.version;
                applyReport(reported);
            } catch (error) {
                if (token !== loop) return;
                failures += 1;
                if (failures === 1) console.warn('[RemotePlayback] The app\'s state could not be read; asking again', error);
                useRemoteTrackStore.setState({ reported: null });
                await sleep(Math.min(30_000, 2_000 * failures));
            }
        }
    })();
};

export type BeginRemoteTrackOptions = {
    song: SongResult;
    startSec?: number;
    /** Started in the app at once; without it the song waits, paused, for a press of play. */
    autoplay: boolean;
};

/**
 * Shows `song` on the remote route and, with `autoplay`, has the app play it. The Web source is
 * cleared and the route set to remote (the HiFi route's guard stops mpv on that). Answers false
 * where the song's platform has no app to play it.
 */
export const beginRemoteTrack = async ({ song, startSec = 0, autoplay }: BeginRemoteTrackOptions): Promise<boolean> => {
    const found = remotePlayerOf(song);
    if (!found) return false;
    attempt += 1;
    const songKey = getPlaybackSongKey(song);
    const track: RemoteTrack = { trackKey: `${songKey}#remote${attempt}`, songKey, providerId: found.providerId, song, mediaId: found.mediaId };
    withoutRouteGuard(() => {
        setAudioSrc(null);
        setPlaybackRoute('remote');
    });
    const durationMs = typeof song.durationMs === 'number' && song.durationMs > 0 ? song.durationMs : null;
    clock = { baseMs: Math.max(0, startSec) * 1000, atMs: Date.now(), paused: true, durationMs };
    remoteMediaShim.beginTrack(track.trackKey);
    useRemoteTrackStore.setState({ current: track, holding: false, starting: false });
    showDuration(durationMs);
    runStateLoop(found.player);
    console.info('[RemotePlayback] The song is handed to its platform\'s app', { songKey, autoplay, startSec });
    if (!autoplay) {
        setPlayerState(PlayerState.PAUSED);
        return true;
    }
    return start(track, clock.baseMs);
};

export const remoteTransport = {
    /** Pauses the app. Answers false off the remote route. */
    pause(): boolean {
        const { current, holding } = useRemoteTrackStore.getState();
        if (!current || !isRemoteRoute()) return false;
        clock = pauseRemoteClock(clock);
        remoteMediaShim.markPaused();
        const player = playerOf(current);
        if (holding && player) {
            void player.control('pause').catch(error => console.warn('[RemotePlayback] The app did not pause', error));
        }
        return true;
    },

    /**
     * Plays on: the app resumes the song it holds, or is handed it anew from where it is shown
     * (a song restored paused, one the app left, one that failed). Answers false off the remote route.
     */
    resume(): boolean {
        const { current, holding, reported } = useRemoteTrackStore.getState();
        if (!current || !isRemoteRoute()) return false;
        const player = playerOf(current);
        if (!player) return false;
        const held = holding && reported?.active === true && reported.mediaId === current.mediaId;
        if (held) {
            const mine = attempt;
            void player.control('resume').catch(error => { if (mine === attempt) fail(current, player, error); });
        } else {
            void start(current, readRemoteClockMs(clock));
        }
        return true;
    },
};

/**
 * Seeks on the remote route; answers false off it. With `resume` a paused song plays on from there
 * (the progress bar and a lyric line, as for <audio>). A song the app does not hold only has its
 * shown position moved: it is handed to the app from there.
 */
export const seekRemoteRoute = (timeSec: number, { resume = false }: { resume?: boolean } = {}): boolean => {
    if (!isRemoteRoute()) return false;
    const { current, holding } = useRemoteTrackStore.getState();
    if (!current || !Number.isFinite(timeSec)) return true;
    const targetMs = Math.max(0, timeSec) * 1000;
    clock = { ...clock, baseMs: targetMs, atMs: Date.now() };
    remoteMediaShim.markSeeked();
    const player = playerOf(current);
    if (holding && player) {
        void player.control('seek', targetMs).catch(error => console.warn('[RemotePlayback] The app did not seek', error));
    }
    if (resume && clock.paused) remoteTransport.resume();
    return true;
};

/** Lets go of the current song: the app is paused where it plays it, and nothing it reports is read. */
const releaseRemote = (reason: string) => {
    attempt += 1;
    loop += 1;
    const { current, holding, reported } = useRemoteTrackStore.getState();
    const player = playerOf(current);
    if (current && holding && player && reported?.active && !reported.paused && reported.mediaId === current.mediaId) {
        void player.control('pause').catch(error => console.warn('[RemotePlayback] The app was not paused as Folia left it', error));
    }
    clock = IDLE_REMOTE_CLOCK;
    remoteMediaShim.reset();
    useRemoteTrackStore.setState({ current: null, holding: false, starting: false });
    if (current) console.info('[RemotePlayback] Left the remote route', { reason, songKey: current.songKey });
};

/** Leaves the remote route for the Web route, for the paths that stop playing without setting a Web source. */
export const leaveRemoteRoute = (reason = 'explicit') => {
    if (!isRemoteRoute() && !useRemoteTrackStore.getState().current) return false;
    releaseRemote(reason);
    withoutRouteGuard(() => setPlaybackRoute('web'));
    return true;
};

let installed = false;

/**
 * Once, at start: the shim is what observers read on this route, and the route guard lets go of the
 * app's song the moment another route takes over (a Web source set, the HiFi route, the stage).
 */
export const installRemotePlayback = () => {
    if (installed) return;
    installed = true;
    registerRouteMedia('remote', remoteMediaShim);
    usePlaybackStore.subscribe((state, previous) => {
        if (ownWriteDepth > 0) return;
        if (state.playbackRoute === 'remote') {
            if (state.audioSrc !== null) leaveRemoteRoute('web source');
            else if (state.activePlaybackContext === 'stage') leaveRemoteRoute('stage');
            return;
        }
        if (previous.playbackRoute === 'remote') releaseRemote(`route set to ${state.playbackRoute}`);
    });
};

export { remoteMediaShim };
export { useRemoteTrackStore } from './remoteTrackStore';
