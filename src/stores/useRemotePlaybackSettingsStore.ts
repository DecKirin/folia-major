import { create } from 'zustand';
import { getStoredString, setStoredString } from './storagePrimitives';

// src/stores/useRemotePlaybackSettingsStore.ts
// Whether a platform's own desktop app may play its songs in Folia's place (src/services/remotePlayback/),
// once the platform has said this account's audio will not play in Folia: a failover, on by default.

export const REMOTE_PLAYBACK_MODE_KEY = 'folia_remote_playback_mode';

// Stored as the words earlier builds wrote: 'off', or 'auto' for on. Their 'always' (without asking
// Folia's own playback first) is gone and reads as on.
const readStoredEnabled = (): boolean => getStoredString(REMOTE_PLAYBACK_MODE_KEY, 'auto') !== 'off';

type RemotePlaybackSettingsState = {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
};

export const useRemotePlaybackSettingsStore = create<RemotePlaybackSettingsState>((set) => ({
    enabled: readStoredEnabled(),
    setEnabled: (enabled) => {
        setStoredString(REMOTE_PLAYBACK_MODE_KEY, enabled ? 'auto' : 'off');
        set({ enabled });
    },
}));
