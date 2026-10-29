import { create } from 'zustand';
import { getStoredString, setStoredString } from './storagePrimitives';

// src/stores/useRemotePlaybackSettingsStore.ts
// When a platform's own desktop app plays its songs in Folia's place (src/services/remotePlayback/):
// 'auto' once the platform has said this account's audio will not play in Folia, 'always' without
// asking Folia's own playback first, 'off' never.

export const REMOTE_PLAYBACK_MODE_KEY = 'folia_remote_playback_mode';

export type RemotePlaybackMode = 'off' | 'auto' | 'always';

const readStoredMode = (): RemotePlaybackMode => {
    const stored = getStoredString(REMOTE_PLAYBACK_MODE_KEY, 'auto');
    return stored === 'off' || stored === 'always' ? stored : 'auto';
};

type RemotePlaybackSettingsState = {
    mode: RemotePlaybackMode;
    setMode: (mode: RemotePlaybackMode) => void;
};

export const useRemotePlaybackSettingsStore = create<RemotePlaybackSettingsState>((set) => ({
    mode: readStoredMode(),
    setMode: (mode) => {
        setStoredString(REMOTE_PLAYBACK_MODE_KEY, mode);
        set({ mode });
    },
}));
