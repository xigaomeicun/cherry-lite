export type { AutoReadCompletion, AutoReadResult } from './AutoReadService'
export { autoReadService } from './AutoReadService'
export type { DictationErrorCategory, DictationPhase, DictationSnapshot } from './DictationService'
export { dictationService } from './DictationService'
export type { ReadMessageAloudInput } from './messagePlayback'
export { readMessageAloud } from './messagePlayback'
export type { MicrophoneDevice } from './microphoneDevices'
export { enumerateMicrophones, subscribeMicrophoneChanges } from './microphoneDevices'
export type { ReadableTextMode, ReadableTextPlan, ReadableTextTrigger } from './readableText'
export {
  chunkReadableText,
  normalizeReadableText,
  planReadableText,
  READABLE_TEXT_CHUNK_LIMIT,
  READABLE_TEXT_CONFIRMATION_THRESHOLD,
  SPEECH_ADAPTER_TEXT_LIMIT
} from './readableText'
export type {
  SpeechPlaybackPhase,
  SpeechPlaybackSnapshot,
  SpeechPlaybackSourceLabel,
  SpeechPlaybackStartInput,
  SpeechPlaybackStartResult
} from './SpeechPlaybackService'
export { speechPlaybackService } from './SpeechPlaybackService'
export { getDefaultVoiceLanguage } from './voiceLanguage'
export { VoiceDomainError, voiceService } from './VoiceService'
export type {
  CapturedVoiceTarget,
  VoiceReplaceRange,
  VoiceTargetInsertResult,
  VoiceTargetRegistration
} from './VoiceTargetManager'
export { voiceTargetManager } from './VoiceTargetManager'
