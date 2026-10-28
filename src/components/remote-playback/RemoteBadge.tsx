import React from 'react';
import { MonitorSpeaker } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { omni } from '../../services/onlineMusic/omni';
import { useRemoteTrackStore } from '../../services/remotePlayback/remoteTrackStore';
import { openSettings } from '../../stores/useSettingsModalStore';

// src/components/remote-playback/RemoteBadge.tsx
// The badge beside the capsule's progress bar while a platform's own app plays the song (the remote
// route): "In <service> app", with the app's device name for the screen reader and the tooltip. A
// press opens the setting that decides when this happens, with what it changes. As HifiBadge, the
// capsule is outside the settings, so only the root colour variables reach it.

type RemoteBadgeProps = {
    isDaylight?: boolean;
    disabled?: boolean;
};

const TONE_CLASS = {
    // The app holds the song and reports on it.
    accent: {
        day: 'text-[color:var(--text-accent)] bg-[color-mix(in_srgb,var(--text-accent)_18%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text-accent)_26%,transparent)]',
        night: 'text-[color:var(--text-accent)] bg-[color-mix(in_srgb,var(--text-accent)_14%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text-accent)_22%,transparent)]',
    },
    // Being handed over, waiting for a press of play, or the app cannot be reached.
    muted: {
        day: 'text-[color:var(--text-secondary)] bg-[color-mix(in_srgb,var(--text-secondary)_14%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text-secondary)_22%,transparent)]',
        night: 'text-[color:var(--text-secondary)] bg-[color-mix(in_srgb,var(--text-secondary)_12%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text-secondary)_20%,transparent)]',
    },
} as const;

const RemoteBadge: React.FC<RemoteBadgeProps> = ({ isDaylight = false, disabled = false }) => {
    const { t } = useTranslation();
    const providerId = useRemoteTrackStore(state => state.current?.providerId ?? null);
    const holding = useRemoteTrackStore(state => state.holding);
    const deviceName = useRemoteTrackStore(state => state.reported?.deviceName ?? null);
    if (!providerId) return null;

    const provider = omni.getProviderLabel(providerId);
    const text = t('remotePlayback.badge', { provider });
    const detail = deviceName
        ? t('remotePlayback.badgeAria', { provider, device: deviceName })
        : t('remotePlayback.badgeAriaNoDevice', { provider });
    const tone = TONE_CLASS[holding ? 'accent' : 'muted'][isDaylight ? 'day' : 'night'];

    return (
        <button
            type="button"
            aria-label={detail}
            title={detail}
            disabled={disabled}
            onClick={(event) => {
                // A press on the capsule itself goes to the player view.
                event.stopPropagation();
                openSettings('options', 'playback', null, 'remotePlayback');
            }}
            className={`flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-4 transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${tone}`}
        >
            <MonitorSpeaker size={11} strokeWidth={2.4} aria-hidden className="shrink-0" />
            <span className="truncate">{text}</span>
        </button>
    );
};

type RemoteProgressRowProps = {
    /** The row's place in the capsule's grid, as the Web route's row. */
    className: string;
    isDaylight?: boolean;
    disabled?: boolean;
    /** The progress bar (the times at both ends and the bar). */
    children: React.ReactNode;
};

/** The capsule's progress row on the remote route: the bar keeps at least 10rem, the badge truncates in what is left. */
export const RemoteProgressRow: React.FC<RemoteProgressRowProps> = ({ className, isDaylight, disabled, children }) => (
    <div className={`${className} flex items-center gap-2`}>
        <div className="min-w-40 flex-1">{children}</div>
        <RemoteBadge isDaylight={isDaylight} disabled={disabled} />
    </div>
);

export default RemoteBadge;
