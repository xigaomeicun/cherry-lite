import { VoiceSettings } from '@renderer/pages/settings/VoiceSettings'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/voice')({
  component: VoiceSettings
})
