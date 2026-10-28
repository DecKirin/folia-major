import type { RemotePlayerState } from '../../types/onlineMusic';

// src/services/remotePlayback/remoteClock.ts
// Where the platform's own app is in the song, and what one report of its state means for the
// song this app shows. The app reports its position only when it changes course (a start, a pause,
// a seek): in between it is counted on from that report, by the clock of `Date.now()`.

export type RemoteClock = {
    /** Where the song was at `atMs`. */
    baseMs: number;
    /** A `Date.now()` time. */
    atMs: number;
    paused: boolean;
    durationMs: number | null;
};

export const IDLE_REMOTE_CLOCK: RemoteClock = { baseMs: 0, atMs: 0, paused: true, durationMs: null };

// A song that stopped this close to its end, back at its start, has ended: the app goes back to the
// start of what it was given (a list of this one song) and stops there.
const ENDED_WITHIN_MS = 4000;
const BACK_AT_START_MS = 1500;
// A report this far from where the count had got to is a seek (in the app, or one of this app's).
const SEEKED_BY_MS = 2000;

export const readRemoteClockMs = (clock: RemoteClock, nowMs = Date.now()): number => {
    const timeMs = clock.paused ? clock.baseMs : clock.baseMs + Math.max(0, nowMs - clock.atMs);
    const atLeastZero = Math.max(0, timeMs);
    return clock.durationMs !== null && clock.durationMs > 0 ? Math.min(atLeastZero, clock.durationMs) : atLeastZero;
};

/** The clock stopped where it has got to. */
export const pauseRemoteClock = (clock: RemoteClock, nowMs = Date.now()): RemoteClock => (
    clock.paused ? clock : { ...clock, baseMs: readRemoteClockMs(clock, nowMs), atMs: nowMs, paused: true }
);

export type RemoteUpdate =
    // The app plays (or holds) this song: the clock as it reports, and whether that ended it or moved it.
    | { kind: 'mine'; clock: RemoteClock; ended: boolean; seeked: boolean }
    // An advertisement plays in the app, in this song's place.
    | { kind: 'ad' }
    // The app held this song and has left it: another song chosen in the app, or another device playing.
    | { kind: 'elsewhere' }
    // The app has not taken this song up yet (it is being started, or waits for a press of play).
    | { kind: 'waiting' };

/**
 * What `state` means for the song with `mediaId`. `holding`: the app has played this song for this
 * one since it was started here; `clock`: the clock as it stood before the report.
 */
export const readRemoteUpdate = (
    { mediaId, holding, clock }: { mediaId: string; holding: boolean; clock: RemoteClock },
    state: RemotePlayerState,
    nowMs = Date.now(),
): RemoteUpdate => {
    if (state.active && state.ad) return holding ? { kind: 'ad' } : { kind: 'waiting' };
    const mine = state.active && state.mediaId === mediaId;
    if (!mine) return holding ? { kind: 'elsewhere' } : { kind: 'waiting' };
    const next: RemoteClock = {
        baseMs: state.positionMs,
        atMs: state.positionAtMs,
        paused: state.paused,
        durationMs: state.durationMs ?? clock.durationMs,
    };
    const counted = readRemoteClockMs(clock, nowMs);
    const ended = holding && !clock.paused && state.paused && state.positionMs < BACK_AT_START_MS
        && next.durationMs !== null && counted >= next.durationMs - ENDED_WITHIN_MS;
    const seeked = holding && !ended && Math.abs(readRemoteClockMs(next, nowMs) - counted) > SEEKED_BY_MS;
    return { kind: 'mine', clock: next, ended, seeked };
};
