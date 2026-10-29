import { describe, expect, it } from 'vitest';
import type { SongResult } from '@/types';
import { remoteBlocksAutomix, type RemoteAutomixGateInput } from '@/components/remote-playback/useRemoteAutomixGate';

// test/unit/remotePlayback/remoteAutomixGate.test.ts
// A transition needs two of Folia's own decks; a platform's own app is neither. Off while the song or
// the next one plays in such an app (src/components/remote-playback/useRemoteAutomixGate.ts), and only then.

const song = (id: string) => ({ id, name: id }) as unknown as SongResult;
const [a, b, c] = [song('a'), song('b'), song('c')];
const inApp = new Set(['b']);
const routeFor = (candidate: SongResult | null | undefined) => Boolean(candidate && inApp.has(String(candidate.id)));
const input = (patch: Partial<RemoteAutomixGateInput>): RemoteAutomixGateInput => ({
    playbackRoute: 'web', playQueue: [a, b, c], currentSong: a, loopMode: 'off', isFmMode: false, ...patch,
});

describe('remoteBlocksAutomix', () => {
    it('blocks on the remote route, and where the song or the next one goes there', () => {
        expect(remoteBlocksAutomix(input({ playbackRoute: 'remote', currentSong: c }), routeFor)).toBe(true);
        expect(remoteBlocksAutomix(input({ currentSong: b }), routeFor)).toBe(true);
        expect(remoteBlocksAutomix(input({ currentSong: a }), routeFor)).toBe(true);
    });

    it('leaves a transition between two songs Folia plays itself alone', () => {
        expect(remoteBlocksAutomix(input({ currentSong: c }), routeFor)).toBe(false);
        expect(remoteBlocksAutomix(input({ playQueue: [a, c], currentSong: a }), routeFor)).toBe(false);
    });
});
