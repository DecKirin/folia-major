import { MonitorSpeaker, Undo2 } from 'lucide-react';
import type { CommandPaletteCommand } from '../types';
import { createSettingsAnchorCommand, createToggleCommand, defineCommand } from '../commandFactories';

// src/components/command-palette/commands/remotePlaybackCommands.ts
// A streaming service's own desktop app playing its songs in Folia's place (src/services/remotePlayback/):
// the setting that decides when, a switch for it, and the way back to Folia's own playback for the
// services whose app plays in this run. Desktop app only, as the setting.

export const remotePlaybackCommands: CommandPaletteCommand[] = [
    createSettingsAnchorCommand(
        'settings-remote-playback',
        'Play through the service\'s app',
        'Open the setting for when a streaming service\'s own app plays its songs, for an account it will not stream to Folia',
        ['service app', 'desktop app', 'official app', 'connect', 'audio key', 'remote playback', 'fallback', '官方客户端', '桌面应用', '远程播放', '音频密钥', '改由应用播放'],
        'remotePlayback',
        { platform: ['electron'] },
    ),
    createToggleCommand(
        'remote-playback-toggle',
        'settings',
        'Service app fallback',
        'Turn on or off letting a streaming service\'s own app play its songs when it will not stream to Folia for your account',
        ['service app', 'desktop app', 'official app', 'connect', 'fallback', 'remote playback', '官方客户端', '桌面应用', '远程播放', '改由应用播放'],
        context => context.settings.toggleRemotePlayback(),
        { platform: ['electron'], icon: MonitorSpeaker },
    ),
    defineCommand({
        id: 'remote-playback-release',
        group: 'settings',
        title: 'Play in Folia again',
        description: 'For the rest of this session, ask Folia\'s own playback for the songs a service\'s app has been playing',
        keywords: ['stop using the app', 'own playback', 'try again', 'audio key', 'release', '不用官方应用', '自己播放', '重新尝试', '恢复直接播放'],
        icon: Undo2,
        platform: ['electron'],
        // Only where a service's app plays in this run, as the settings row that offers the same button.
        isAvailable: context => context?.settings.hasRemotePlaybackEngaged() ?? false,
        execute: (_input, context) => {
            context.settings.releaseRemotePlayback();
            context.shared.setStatusMsg({ type: 'success', text: context.shared.t('remotePlayback.released') });
            return true;
        },
    }),
];
