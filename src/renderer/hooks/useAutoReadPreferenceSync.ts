import { usePreference } from '@data/hooks/usePreference'
import { autoReadService } from '@renderer/services/voice'
import { useEffect } from 'react'

export function useAutoReadPreferenceSync(): void {
  const [enabled] = usePreference('feature.voice.auto_read.enabled')
  useEffect(() => {
    void autoReadService.setEnabled(enabled)
  }, [enabled])
}
