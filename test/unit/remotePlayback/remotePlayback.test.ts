import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import type { OnlineRemotePlayer, RemotePlayerState } from '@/types/onlineMusic';

// test/unit/remotePlayback/remotePlayback.test.ts
// The remote route against the real playback store and a stand-in for the platform's app
// (src/services/remotePlayback/remotePlayback.ts): a song handed to the app, followed by its reports,
// and let go of - the app paused - the moment any other route takes over, so that the song of
// another platform that comes next plays in Folia alone.

const ID = '3WtIXrla0ovC9MOIY78Vr8';
let pushReport: (state: RemotePlayerState) => void = () => {};
const control = vi.fn(async (_action: string, _value?: number) => {});
const play = vi.fn(async (_song: SongResult, _positionMs: number) => {});
const player: OnlineRemotePlayer = {
    takesOver: () => true,
    play,
    control,
    // The first call answers at once; later ones wait for the next pushed report.
    waitState: (after) => new Promise(resolve => {
        if (after === null) resolve(report({ active: false, mediaId: null }));
        else pushReport = resolve;
    }),
    failureKind: () => 'refused',
    release: async () => {},
};
vi.mock('@/services/onlineMusic/omni', () => ({
    omni: { getRemotePlayer: (providerId: string) => (providerId === 'spotify' ? player : null) },
}));

const { beginRemoteTrack, installRemotePlayback, remoteTransport, getRemotePosition } = await import('@/services/remotePlayback/remotePlayback');
const { useRemoteTrackStore } = await import('@/services/remotePlayback/remoteTrackStore');
const { setAudioSrc, setPlaybackRoute, usePlaybackStore } = await import('@/stores/usePlaybackStore');
const { PlayerState } = await import('@/types');

const report = (patch: Partial<RemotePlayerState> = {}): RemotePlayerState => ({
    version: 1, connected: true, deviceName: 'Mac', active: true, mediaId: ID, ad: false,
    paused: false, positionMs: 0, positionAtMs: Date.now(), durationMs: 227_731, ...patch,
});
const song = { id: ID, name: '又三郎', durationMs: 227_731, sourceRef: { kind: 'online', providerId: 'spotify', mediaId: ID } } as unknown as SongResult;
const flush = () => new Promise(resolve => { setTimeout(resolve, 0); });

// Hands the song to the app and has the app report that it plays it.
const playInApp = async () => {
    await beginRemoteTrack({ song, autoplay: true });
    await flush();
    pushReport(report({ version: 2, positionMs: 30_000 }));
    await flush();
};

beforeEach(() => {
    installRemotePlayback();
    setPlaybackRoute('web');
    setAudioSrc(null);
    useRemoteTrackStore.setState({ current: null, holding: false });
    control.mockClear();
    play.mockClear();
});

describe('the remote route', () => {
    it('hands the song to the app, and follows its report', async () => {
        await playInApp();
        expect(play).toHaveBeenCalledWith(song, 0);
        expect(usePlaybackStore.getState()).toMatchObject({ playbackRoute: 'remote', audioSrc: null, playerState: PlayerState.PLAYING, duration: 227.731 });
        expect(useRemoteTrackStore.getState().holding).toBe(true);
        expect(getRemotePosition()).toBeGreaterThanOrEqual(30);
    });

    it('pauses the app and leaves the route when a Web source is set (the next song is another platform\'s)', async () => {
        await playInApp();
        setAudioSrc('blob:another-platform');
        expect(control).toHaveBeenCalledWith('pause');
        expect(usePlaybackStore.getState().playbackRoute).toBe('web');
        expect(useRemoteTrackStore.getState().current).toBeNull();
    });

    it('pauses the app when the HiFi route takes over', async () => {
        await playInApp();
        setPlaybackRoute('hifi');
        expect(control).toHaveBeenCalledWith('pause');
        expect(useRemoteTrackStore.getState().current).toBeNull();
    });

    it('does not touch the app for a song it is not playing', async () => {
        await beginRemoteTrack({ song, autoplay: false });
        setAudioSrc('blob:another-platform');
        expect(control).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().playbackRoute).toBe('web');
    });

    it('hands a song restored paused to the app from where it was left, on the first press of play', async () => {
        await beginRemoteTrack({ song, startSec: 61, autoplay: false });
        expect(play).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().playerState).toBe(PlayerState.PAUSED);
        expect(remoteTransport.resume()).toBe(true);
        expect(play).toHaveBeenCalledWith(song, 61_000);
    });

    it('leaves Folia\'s other routes alone: off the remote route its transport does nothing', () => {
        expect(remoteTransport.pause()).toBe(false);
        expect(remoteTransport.resume()).toBe(false);
        expect(control).not.toHaveBeenCalled();
    });
});
