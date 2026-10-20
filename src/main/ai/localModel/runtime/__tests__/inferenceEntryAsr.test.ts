import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CPU_LOCAL_INFERENCE_PROFILE } from '../inferenceAcceleration'
import { loadInferenceEntries } from './inferenceEntryHarness'

let appPath: string

beforeEach(async () => {
  appPath = await mkdtemp(path.join(tmpdir(), 'cherry-mlx-asr-'))
  const directory = path.join(appPath, 'node_modules/@cherrystudio/mlx-asr')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }))
  await writeFile(
    path.join(directory, 'index.js'),
    `
    let attempts = 0
    export class Qwen3AsrModel {
      static async load(dir) {
        if (dir === '/retry' && attempts++ === 0) throw new Error('load failed')
        return new Qwen3AsrModel()
      }
      async transcribe(samples, options) {
        if (options.language) throw new Error('Expected automatic language detection')
        if (options.sampleRate !== 16000) throw new Error('Wrong sample rate')
        return { text: '  你好 Hello  ', isFinal: samples[0] !== 2, reachedMaxTokens: samples[0] === 3 }
      }
    }
  `
  )
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(appPath, { recursive: true, force: true })
})

const input = (first = 0, modelDir = '/model') => ({
  engine: 'mlx' as const,
  modelDir,
  source: { kind: 'samples' as const, samples: new Float32Array([first]), sampleRate: 16000 }
})
const load = () => loadInferenceEntries({ appPath, artifactPaths: {}, runtimeProfile: CPU_LOCAL_INFERENCE_PROFILE })

describe('Qwen3 ASR utility entry', () => {
  it('recognizes complete audio without loading Sherpa or fabricating timestamps', async () => {
    const { asr } = await load()
    await expect(asr.transcribe(input())).resolves.toEqual({ text: '你好 Hello', segments: [] })
  })

  it.each([2, 3])('rejects incomplete recognition instead of silently accepting truncated text (%s)', async (first) => {
    const { asr } = await load()
    await expect(asr.transcribe(input(first))).rejects.toThrow('truncated')
  })

  it('allows another attempt after native model initialization fails', async () => {
    const { asr } = await load()
    await expect(asr.transcribe(input(0, '/retry'))).rejects.toMatchObject({ code: 'ASR_MODEL_LOAD_FAILED' })
    await expect(asr.transcribe(input(0, '/retry'))).resolves.toEqual({ text: '你好 Hello', segments: [] })
  })

  it.each([NaN, Infinity])('rejects non-finite PCM before native inference (%s)', async (first) => {
    const { asr } = await load()
    await expect(asr.transcribe(input(first))).rejects.toMatchObject({ code: 'VOICE_AUDIO_INVALID' })
  })

  it('rejects empty or incorrectly sampled PCM', async () => {
    const { asr } = await load()
    const request = input()
    request.source.sampleRate = 48000
    await expect(asr.transcribe(request)).rejects.toMatchObject({ code: 'VOICE_AUDIO_INVALID' })
    request.source.sampleRate = 16000
    request.source.samples = new Float32Array()
    await expect(asr.transcribe(request)).rejects.toMatchObject({ code: 'VOICE_AUDIO_INVALID' })
  })
})
