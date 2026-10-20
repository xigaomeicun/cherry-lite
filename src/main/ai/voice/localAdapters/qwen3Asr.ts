import type { TranscriptionModelV3 } from '@ai-sdk/provider'
import { application } from '@application'
import type { TranscriptionOptions } from '@cherrystudio/ai-core'
import { loggerService } from '@logger'
import { UtilityProcessError } from '@main/core/utilityProcess/UtilityProcessError'
import { regionService } from '@main/services/RegionService'
import { LOCAL_VOICE_MODELS, VoiceResourceOperation } from '@shared/ai/localVoice'
import { QWEN3_ASR_BUNDLE_ID, QWEN3_ASR_MODEL_ID } from '@shared/ai/localVoice'
import { LOCAL_MODEL_STATUS_CACHE_KEY } from '@shared/data/presets/localModel'

import type { TranscriptionModelDefinition } from '../voiceModelTypes'
import type { LocalVoiceStatus } from '../voiceModelTypes'
import { mlxVoiceSupport } from '../voicePlatform'
import { checkAbort, VoiceRuntimeError } from '../VoiceRuntimeError'
import { inspectCanonicalWav } from './inspectCanonicalWav'
import { decodeVoiceRecording } from './recordingDecoder'
import { completeTranscriptionOperation } from './sdkOperations'

const ASR_INFERENCE_TIMEOUT_MS = 120_000
const logger = loggerService.withContext('Qwen3AsrAdapter')

function normalizeFailure(error: unknown, signal?: AbortSignal): VoiceRuntimeError {
  if (signal?.aborted) return new VoiceRuntimeError('aborted')
  if (error instanceof VoiceRuntimeError) return error
  if (error instanceof UtilityProcessError && error.code === 'PROCESS_BLOCKED') return new VoiceRuntimeError('busy')
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ASR_MODEL_LOAD_FAILED')
    return new VoiceRuntimeError('model_load_failed')
  if (
    error instanceof UtilityProcessError &&
    typeof error.remote?.code === 'string' &&
    ['VOICE_AUDIO_INVALID', 'VOICE_AUDIO_UNSUPPORTED', 'VOICE_AUDIO_LIMIT'].includes(error.remote.code)
  )
    return new VoiceRuntimeError('invalid_audio')
  if (error instanceof UtilityProcessError && error.remote?.code === 'ASR_MODEL_LOAD_FAILED')
    return new VoiceRuntimeError('model_load_failed')
  if (
    error instanceof UtilityProcessError &&
    ['PROCESS_START_FAILED', 'PROCESS_EXITED', 'PROCESS_PROTOCOL_ERROR', 'PROCESS_CIRCUIT_OPEN'].includes(error.code)
  )
    return new VoiceRuntimeError('worker_crashed')
  return new VoiceRuntimeError('operation_failed')
}

export function getQwen3AsrStatus(signal?: AbortSignal): LocalVoiceStatus {
  checkAbort(signal)
  const { status } = application.get('LocalModelService').refreshStatus(QWEN3_ASR_BUNDLE_ID)
  switch (status) {
    case 'not_downloaded':
      return { status: 'not_installed', reason: 'model_required' }
    case 'downloading':
      return {
        status: 'installing',
        reason: 'model_required',
        percent:
          application.get('CacheService').getShared(LOCAL_MODEL_STATUS_CACHE_KEY)?.[QWEN3_ASR_BUNDLE_ID]?.percent ?? 0
      }
    case 'ready':
      return { status: 'ready' }
    case 'error':
      return { status: 'failed', reason: 'download_failed' }
    case 'unsupported':
      return { status: 'unsupported', reason: 'unsupported' }
  }
}

async function requireReady(signal?: AbortSignal): Promise<void> {
  const status = getQwen3AsrStatus(signal)
  if (status.status !== 'ready') throw new VoiceRuntimeError(status.reason ?? 'operation_failed')
}

export function createQwen3AsrTranscriptionModel(options: TranscriptionOptions): TranscriptionModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'local-voice',
    modelId: QWEN3_ASR_MODEL_ID,
    async doGenerate(input) {
      if (options.language) throw new VoiceRuntimeError('invalid_request')
      if (!(input.audio instanceof Uint8Array)) throw new VoiceRuntimeError('invalid_audio')
      const audio = input.audio
      const isWebm = ['audio/webm', 'audio/webm;codecs=opus'].includes(input.mediaType)
      const wavMetadata = input.mediaType === 'audio/wav' ? inspectCanonicalWav(audio) : undefined
      if (!isWebm && !wavMetadata) throw new VoiceRuntimeError('invalid_audio')
      await requireReady(input.abortSignal)
      try {
        const wav = wavMetadata ? audio : (await decodeVoiceRecording(audio, input.abortSignal)).wav
        const metadata = wavMetadata ?? inspectCanonicalWav(wav)
        const view = new DataView(wav.buffer, wav.byteOffset + metadata.dataOffset, metadata.dataBytes)
        const samples = Float32Array.from(
          { length: metadata.dataBytes / 2 },
          (_, index) => view.getInt16(index * 2, true) / 32768
        )
        checkAbort(input.abortSignal)
        const timeout = AbortSignal.timeout(ASR_INFERENCE_TIMEOUT_MS)
        const signal = input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout
        const transcript = await application
          .get('AsrInferenceService')
          .transcribe(QWEN3_ASR_BUNDLE_ID, { kind: 'samples', samples, sampleRate: 16_000 }, signal)
          .catch((error: unknown) => {
            if (timeout.aborted && !input.abortSignal?.aborted) throw new VoiceRuntimeError('timeout')
            throw error
          })
        checkAbort(input.abortSignal)
        logger.debug('Local transcription completed', {
          modelId: QWEN3_ASR_MODEL_ID,
          durationSeconds: metadata.durationSeconds,
          transcriptNonEmpty: transcript.text.length > 0
        })
        return {
          text: transcript.text,
          segments: [],
          language: undefined,
          durationInSeconds: metadata.durationSeconds,
          warnings: [],
          response: { timestamp: new Date(), modelId: QWEN3_ASR_MODEL_ID }
        }
      } catch (error) {
        throw normalizeFailure(error, input.abortSignal)
      }
    }
  }
}

export const qwen3AsrTranscriptionDefinition: TranscriptionModelDefinition = {
  id: QWEN3_ASR_MODEL_ID,
  adapterId: 'mlx',
  support: mlxVoiceSupport,
  describe: () => ({
    ...LOCAL_VOICE_MODELS.find((model) => model.id === QWEN3_ASR_MODEL_ID)!,
    localeSelection: null,
    resourceOperations: [
      VoiceResourceOperation.Download,
      VoiceResourceOperation.CancelDownload,
      VoiceResourceOperation.Remove
    ]
  }),
  status: (_options, signal) => getQwen3AsrStatus(signal),
  locales: async () => ({ supported: [], installed: [] }),
  transcriptionOperations: [completeTranscriptionOperation(createQwen3AsrTranscriptionModel)],
  download: () =>
    application
      .get('LocalModelService')
      .download(QWEN3_ASR_BUNDLE_ID, async () => ((await regionService.isInChina()) ? 'china-first' : 'global-first'))
      .catch(() => {
        throw new VoiceRuntimeError('download_failed')
      }),
  cancelDownload: () => application.get('LocalModelService').cancel(QWEN3_ASR_BUNDLE_ID),
  remove: () => application.get('LocalModelService').remove(QWEN3_ASR_BUNDLE_ID)
}
