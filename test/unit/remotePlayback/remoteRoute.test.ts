import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import type { OnlineRemotePlayer } from '@/types/onlineMusic';

// test/unit/remotePlayback/remoteRoute.test.ts
// Which songs play in their platform's own app (src/services/remotePlayback/remoteRoute.ts). The
// route is a fallback that must leave every other song alone: a local or Navidrome song, and a song
// of a platform without such an app, never go there, whatever the setting and whatever happened.

const takesOver = vi.fn((error: unknown) => error === 'no key for this account');
const player = { takesOver } as unknown as OnlineRemotePlayer;
vi.mock('@/services/onlineMusic/omni', () => ({
    omni: { getRemotePlayer: (providerId: string) => (providerId === 'spotify' ? player : null) },
}));

const { disengageRemote, noteRemoteTakeover, remotePlayerOf, remoteRouteFor } = await import('@/services/remotePlayback/remoteRoute');
const { useRemoteTrackStore } = await import('@/services/remotePlayback/remoteTrackStore');
const { useRemotePlaybackSettingsStore } = await import('@/stores/useRemotePlaybackSettingsStore');

const online = (providerId: string, mediaId = '3n3Ppam7vgaVa1iaRUc9Lp') => ({
    id: mediaId, name: 'Song', sourceRef: { kind: 'online', providerId, mediaId },
}) as unknown as SongResult;
const spotifySong = online('spotify');
const neteaseSong = online('netease', '186016');
const localSong = { id: 'local-1', name: 'Local', sourceRef: { kind: 'local', mediaId: 'local-1' } } as unknown as SongResult;
const navidromeSong = { id: 'n-1', name: 'Navidrome', sourceRef: { kind: 'navidrome', mediaId: 'n-1' } } as unknown as SongResult;
const others = [neteaseSong, localSong, navidromeSong];

beforeEach(() => {
    useRemoteTrackStore.setState({ engaged: [], notice: null });
    useRemotePlaybackSettingsStore.setState({ enabled: true });
    takesOver.mockClear();
});

describe('remoteRouteFor', () => {
    it('is off for every song by default, until the platform says the account\'s audio will not play here', () => {
        expect([spotifySong, ...others].map(remoteRouteFor)).toEqual([false, false, false, false]);
        expect(noteRemoteTakeover(spotifySong, 'no key for this account')).toBe(true);
        expect([spotifySong, ...others].map(remoteRouteFor)).toEqual([true, false, false, false]);
    });

    it('is not turned on by a failure that the platform\'s app does not take over (a network, one song)', () => {
        expect(noteRemoteTakeover(spotifySong, 'network')).toBe(false);
        expect(remoteRouteFor(spotifySong)).toBe(false);
    });

    it('is never turned on by a song of a platform without an app, nor by a local or Navidrome song', () => {
        for (const song of others) expect(noteRemoteTakeover(song, 'no key for this account')).toBe(false);
        expect(takesOver).not.toHaveBeenCalled();
        expect(useRemoteTrackStore.getState().engaged).toEqual([]);
    });

    it('is never turned on with the setting off, and stops at once when it is turned off', () => {
        useRemotePlaybackSettingsStore.setState({ enabled: false });
        expect(noteRemoteTakeover(spotifySong, 'no key for this account')).toBe(false);
        expect(remoteRouteFor(spotifySong)).toBe(false);
        useRemotePlaybackSettingsStore.setState({ enabled: true });
        expect(noteRemoteTakeover(spotifySong, 'no key for this account')).toBe(true);
        useRemotePlaybackSettingsStore.setState({ enabled: false });
        expect(remoteRouteFor(spotifySong)).toBe(false);
    });

    it('tells the listener once, and goes back to Folia\'s own playback when disengaged', () => {
        noteRemoteTakeover(spotifySong, 'no key for this account');
        const told = useRemoteTrackStore.getState().notice;
        expect(told).toMatchObject({ kind: 'engaged', providerId: 'spotify' });
        noteRemoteTakeover(spotifySong, 'no key for this account');
        expect(useRemoteTrackStore.getState().notice).toBe(told);
        disengageRemote('spotify');
        expect(remoteRouteFor(spotifySong)).toBe(false);
    });
});

describe('remotePlayerOf', () => {
    it('names the platform and the song\'s id on it, and nothing for other songs', () => {
        expect(remotePlayerOf(spotifySong)).toEqual({ providerId: 'spotify', player, mediaId: '3n3Ppam7vgaVa1iaRUc9Lp' });
        expect(others.map(remotePlayerOf)).toEqual([null, null, null]);
    });
});
