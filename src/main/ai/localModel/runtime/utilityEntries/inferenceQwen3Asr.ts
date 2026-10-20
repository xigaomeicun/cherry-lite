import type { Qwen3AsrModel } from '@cherrystudio/mlx-asr'
import type { AsrSegment, AsrTranscribePayload } from '@main/ai/localModel/capabilities/asr/protocol'
import type { UtilityProcessHandlerContext } from '@main/core/utilityProcess/runtime/serveUtilityProcess'

import { getMlxAsr } from './inferenceRuntime'

// Model switches and cancellation terminate the owning process; the native API has no dispose method.
let cached: Promise<Qwen3AsrModel> | undefined

export async function transcribeQwen3Asr(
  { modelDir, source }: Extract<AsrTranscribePayload, { engine: 'mlx' }>,
  { signal }: UtilityProcessHandlerContext<never>
): Promise<{ text: string; segments: AsrSegment[] }> {
  signal.throwIfAborted()
  if (source.sampleRate !== 16_000 || !source.samples.length || !source.samples.every(Number.isFinite))
    throw Object.assign(new Error('Invalid ASR PCM'), { code: 'VOICE_AUDIO_INVALID' })
  cached ??= (async () => {
    try {
      const runtime = await getMlxAsr()
      return await runtime.Qwen3AsrModel.load(modelDir)
    } catch (cause) {
      cached = undefined
      throw Object.assign(new Error('ASR model initialization failed', { cause }), { code: 'ASR_MODEL_LOAD_FAILED' })
    }
  })()
  const model = await cached
  signal.throwIfAborted()
  const result = await model.transcribe(source.samples, { sampleRate: source.sampleRate, maxTokens: 4096 })
  signal.throwIfAborted()
  if (result.reachedMaxTokens || !result.isFinal) throw new Error('ASR output was truncated')
  return { text: result.text.trim(), segments: [] }
}
