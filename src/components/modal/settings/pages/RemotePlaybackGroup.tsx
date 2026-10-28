import React from 'react';
import { useTranslation } from 'react-i18next';
import { omni } from '../../../../services/onlineMusic/omni';
import { disengageRemote } from '../../../../services/remotePlayback/remoteRoute';
import { useRemoteTrackStore } from '../../../../services/remotePlayback/remoteTrackStore';
import { useRemotePlaybackSettingsStore, type RemotePlaybackMode } from '../../../../stores/useRemotePlaybackSettingsStore';
import { Button, Group, Row, Segmented, Status, option, type SettingsGroupDef } from '../kit';

// src/components/modal/settings/pages/RemotePlaybackGroup.tsx
// On the 播放控制 page (desktop app only): when a streaming service's own desktop app plays its songs
// in Folia's place (src/services/remotePlayback/), and which services' songs it plays in this run,
// with the way back to Folia's own playback for them. The badge on the player capsule opens here.

const REMOTE: SettingsGroupDef = { id: 'remotePlayback', titleKey: 'options.remotePlaybackSettings', electronOnly: true };

const O = {
    mode: option(REMOTE, 'remotePlaybackMode', 'options.remotePlaybackMode'),
};

export const REMOTE_PLAYBACK_OPTIONS = Object.values(O);

const RemotePlaybackGroup: React.FC = () => {
    const { t } = useTranslation();
    const mode = useRemotePlaybackSettingsStore(state => state.mode);
    const setMode = useRemotePlaybackSettingsStore(state => state.setMode);
    const engaged = useRemoteTrackStore(state => state.engaged);
    const providers = engaged.map(providerId => omni.getProviderLabel(providerId)).join(', ');

    return (
        <Group def={REMOTE}>
            <Row option={O.mode} hint={t('options.remotePlaybackModeDesc')} note={t('options.remotePlaybackModeNote')}>
                <Segmented<RemotePlaybackMode>
                    value={mode}
                    options={[
                        { value: 'off', label: t('options.remotePlaybackOff') },
                        { value: 'auto', label: t('options.remotePlaybackAuto') },
                        { value: 'always', label: t('options.remotePlaybackAlways') },
                    ]}
                    onChange={setMode}
                />
            </Row>
            {/* Only in 'auto': there the services listed are the ones that said so in this run. */}
            {mode === 'auto' && engaged.length > 0 && (
                <Row sub notice={t('options.remotePlaybackEngaged', { providers })}>
                    <Status tone="ok">{t('options.remotePlaybackEngagedStatus')}</Status>
                    <Button onClick={() => engaged.forEach(disengageRemote)}>{t('options.remotePlaybackRelease')}</Button>
                </Row>
            )}
        </Group>
    );
};

export default RemotePlaybackGroup;
