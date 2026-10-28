import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnlineProviderError } from '@/types/onlineMusic';

// test/unit/spotify/spotifyRemotePlayer.test.ts
// Which of the desktop side's audio failures hand Spotify songs to Spotify's own app
// (src/services/onlineMusic/spotify/spotifyRemotePlayer.ts): the ones that hold for every song of
// the account, never one that passes or that concerns one song.

const { spotifyRemotePlayer } = await import('@/services/onlineMusic/spotify/spotifyRemotePlayer');

const fromDesktop = (code: ConstructorParameters<typeof OnlineProviderError>[0], message: string) => new OnlineProviderError(code, message, 'spotify');

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('spotifyRemotePlayer.takesOver', () => {
    it('takes over for an account given no key and a system without the playback component', () => {
        vi.stubGlobal('window', { electron: { spotifyRequest: () => undefined } });
        expect(spotifyRemotePlayer.takesOver(fromDesktop('unavailable', 'Spotify gives this account no audio key'))).toBe(true);
        expect(spotifyRemotePlayer.takesOver(fromDesktop('unavailable', 'Spotify playback is not available on this system'))).toBe(true);
    });

    it('does not for a free account, which Spotify Connect will not let be steered from here', () => {
        vi.stubGlobal('window', { electron: { spotifyRequest: () => undefined } });
        expect(spotifyRemotePlayer.takesOver(fromDesktop('subscription-required', 'Spotify plays for Premium accounts only'))).toBe(false);
    });

    it('does not for a refusal that passes, one song, a network, or another platform', () => {
        vi.stubGlobal('window', { electron: { spotifyRequest: () => undefined } });
        expect(spotifyRemotePlayer.takesOver(fromDesktop('unavailable', 'Spotify refused the audio key for now'))).toBe(false);
        expect(spotifyRemotePlayer.takesOver(fromDesktop('not-playable', 'Spotify has no audio for this track'))).toBe(false);
        expect(spotifyRemotePlayer.takesOver(fromDesktop('network', 'Spotify could not be reached'))).toBe(false);
        expect(spotifyRemotePlayer.takesOver(new OnlineProviderError('subscription-required', 'x', 'qq'))).toBe(false);
    });

    it('does not in the web version, which has no desktop app to steer', () => {
        vi.stubGlobal('window', {});
        expect(spotifyRemotePlayer.takesOver(fromDesktop('unavailable', 'Spotify gives this account no audio key'))).toBe(false);
    });
});

describe('spotifyRemotePlayer.failureKind', () => {
    it('reads the desktop side\'s sentences', () => {
        expect(spotifyRemotePlayer.failureKind(fromDesktop('unavailable', 'The Spotify app is not installed on this computer'))).toBe('app-missing');
        expect(spotifyRemotePlayer.failureKind(fromDesktop('unavailable', 'The Spotify app on this computer is not playing for this account'))).toBe('app-not-found');
        expect(spotifyRemotePlayer.failureKind(fromDesktop('network', 'Spotify Connect could not be reached'))).toBe('unreachable');
        expect(spotifyRemotePlayer.failureKind(fromDesktop('unavailable', 'Spotify Connect refused the command'))).toBe('refused');
    });
});
