import { InfoTooltip, Switch } from '@cherrystudio/ui'
import { useMultiplePreferences } from '@data/hooks/usePreference'
import {
  SettingDivider,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingsContentColumn,
  SettingTitle
} from '@renderer/components/SettingsPrimitives'
import { useTheme } from '@renderer/hooks/useTheme'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

const NotificationSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()

  const [notificationSettings, setNotificationSettings] = useMultiplePreferences({
    assistant: 'app.notification.assistant.enabled',
    completion_sound: 'app.notification.completion_sound.enabled',
    approval_sound: 'app.notification.approval_sound.enabled',
    backup: 'app.notification.backup.enabled',
    knowledge: 'app.notification.knowledge.enabled',
    update: 'app.notification.update.enabled',
    'mini-app': 'app.notification.mini_app.enabled'
  })

  const handleNotificationChange = (type: string, value: boolean) => {
    void setNotificationSettings({ [type]: value })
  }

  return (
    <SettingsContentColumn theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.notification.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow id="setting-notifications-assistant-notification" className="scroll-mt-6">
          <SettingRowTitle style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>{t('settings.notification.assistant')}</span>
            <InfoTooltip
              content={t('notification.tip')}
              placement="right"
              iconProps={{ className: 'cursor-pointer' }}
            />
          </SettingRowTitle>
          <Switch
            checked={notificationSettings.assistant}
            onCheckedChange={(v) => handleNotificationChange('assistant', v)}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow id="setting-notifications-completion-sound" className="scroll-mt-6">
          <SettingRowTitle style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>任务完成音效</span>
            <InfoTooltip
              content="Cursor 同款 done1：对话/Agent 一轮完成后播放（前台也响）"
              placement="right"
              iconProps={{ className: 'cursor-pointer' }}
            />
          </SettingRowTitle>
          <Switch
            checked={notificationSettings.completion_sound}
            onCheckedChange={(v) => handleNotificationChange('completion_sound', v)}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow id="setting-notifications-approval-sound" className="scroll-mt-6">
          <SettingRowTitle style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>权限审批音效</span>
            <InfoTooltip
              content="Cursor 同款 terminalBell：需要工具权限批准时播放（前台也响）"
              placement="right"
              iconProps={{ className: 'cursor-pointer' }}
            />
          </SettingRowTitle>
          <Switch
            checked={notificationSettings.approval_sound}
            onCheckedChange={(v) => handleNotificationChange('approval_sound', v)}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow id="setting-notifications-backup-notification" className="scroll-mt-6">
          <SettingRowTitle>{t('settings.notification.backup')}</SettingRowTitle>
          <Switch
            checked={notificationSettings.backup}
            onCheckedChange={(v) => handleNotificationChange('backup', v)}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow id="setting-notifications-knowledge-embed-notification" className="scroll-mt-6">
          <SettingRowTitle>{t('settings.notification.knowledge_embed')}</SettingRowTitle>
          <Switch
            checked={notificationSettings.knowledge}
            onCheckedChange={(v) => handleNotificationChange('knowledge', v)}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow id="setting-notifications-update-notification" className="scroll-mt-6">
          <SettingRowTitle>{t('settings.notification.update')}</SettingRowTitle>
          <Switch
            aria-label={t('settings.notification.update')}
            checked={notificationSettings.update}
            onCheckedChange={(v) => handleNotificationChange('update', v)}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow id="setting-notifications-mini-app-notification" className="scroll-mt-6">
          <SettingRowTitle>{t('settings.notification.mini_app')}</SettingRowTitle>
          <Switch
            aria-label={t('settings.notification.mini_app')}
            checked={notificationSettings['mini-app']}
            onCheckedChange={(v) => handleNotificationChange('mini-app', v)}
          />
        </SettingRow>
      </SettingGroup>
    </SettingsContentColumn>
  )
}

export default NotificationSettings
