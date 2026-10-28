import { describe, expect, it } from 'vitest';
import { pauseRemoteClock, readRemoteClockMs, readRemoteUpdate, type RemoteClock } from '@/services/remotePlayback/remoteClock';
import type { RemotePlayerState } from '@/types/onlineMusic';

// test/unit/remotePlayback/remoteClock.test.ts
// The remote route's clock and its reading of the app's reports (src/services/remotePlayback/remoteClock.ts).
// The app reports its position only when it changes course; the probe of 2026-10-27 measured how a
// one-track list ends: the app goes back to the track's start and stops there.

const ID = '3n3Ppam7vgaVa1iaRUc9Lp';
const report = (patch: Partial<RemotePlayerState> = {}): RemotePlayerState => ({
    version: 1, connected: true, deviceName: 'Mac', active: true, mediaId: ID, ad: false,
    paused: false, positionMs: 0, positionAtMs: 1000, durationMs: 200_000, ...patch,
});
const playing = (baseMs: number, atMs: number): RemoteClock => ({ baseMs, atMs, paused: false, durationMs: 200_000 });

describe('readRemoteClockMs', () => {
    it('counts on while playing, stands still while paused, and stays within the song', () => {
        expect(readRemoteClockMs(playing(30_000, 1000), 4000)).toBe(33_000);
        expect(readRemoteClockMs({ ...playing(30_000, 1000), paused: true }, 4000)).toBe(30_000);
        expect(readRemoteClockMs(playing(199_000, 0), 10_000)).toBe(200_000);
        expect(readRemoteClockMs(playing(5000, 10_000), 2000)).toBe(5000);
    });

    it('pauses where the count has got to', () => {
        expect(pauseRemoteClock(playing(30_000, 1000), 3500)).toEqual({ baseMs: 32_500, atMs: 3500, paused: true, durationMs: 200_000 });
    });
});

describe('readRemoteUpdate', () => {
    it('waits while the app has not taken the song up', () => {
        const clock = playing(0, 0);
        expect(readRemoteUpdate({ mediaId: ID, holding: false, clock }, report({ mediaId: 'another00000000000000000' }))).toEqual({ kind: 'waiting' });
        expect(readRemoteUpdate({ mediaId: ID, holding: false, clock }, report({ active: false }))).toEqual({ kind: 'waiting' });
    });

    it('follows the app\'s report for the song it holds', () => {
        const update = readRemoteUpdate({ mediaId: ID, holding: false, clock: playing(0, 0) }, report({ positionMs: 30_000, positionAtMs: 5000 }), 5000);
        expect(update).toEqual({ kind: 'mine', clock: { baseMs: 30_000, atMs: 5000, paused: false, durationMs: 200_000 }, ended: false, seeked: false });
    });

    it('takes a stop back at the start, near the end of the count, as the end of the song', () => {
        const clock = playing(195_000, 0);
        const update = readRemoteUpdate({ mediaId: ID, holding: true, clock }, report({ paused: true, positionMs: 0, positionAtMs: 4500 }), 4500);
        expect(update).toMatchObject({ kind: 'mine', ended: true });
    });

    it('takes a pause at the start of a song well before its end as a pause, not an end', () => {
        const update = readRemoteUpdate({ mediaId: ID, holding: true, clock: playing(0, 0) }, report({ paused: true, positionMs: 500, positionAtMs: 500 }), 500);
        expect(update).toMatchObject({ kind: 'mine', ended: false, seeked: false });
    });

    it('takes a jump in the report as a seek', () => {
        const update = readRemoteUpdate({ mediaId: ID, holding: true, clock: playing(10_000, 0) }, report({ positionMs: 90_000, positionAtMs: 1000 }), 1000);
        expect(update).toMatchObject({ kind: 'mine', seeked: true, ended: false });
    });

    it('tells an ad and another song or device apart once the app held the song', () => {
        const clock = playing(10_000, 0);
        expect(readRemoteUpdate({ mediaId: ID, holding: true, clock }, report({ ad: true, mediaId: null }))).toEqual({ kind: 'ad' });
        expect(readRemoteUpdate({ mediaId: ID, holding: true, clock }, report({ mediaId: 'another00000000000000000' }))).toEqual({ kind: 'elsewhere' });
        expect(readRemoteUpdate({ mediaId: ID, holding: true, clock }, report({ active: false }))).toEqual({ kind: 'elsewhere' });
    });
});
