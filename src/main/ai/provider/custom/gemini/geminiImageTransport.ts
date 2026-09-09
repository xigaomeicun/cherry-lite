import { withoutTrailingSlash } from '@ai-sdk/provider-utils'

import type { ImageGenerationSubmitInput, ImageGenerationTransport } from '../imageGenerationModel'
import { readErrorMessage } from '../readErrorMessage'
import { fileToDataUrl } from '../transportUtils'

/**
 * CLI Proxy / OpenAI-compatible single-shot transport for `gemini-image`.
 *
 * POSTs `${baseURL}/chat/completions` with either a plain prompt string or a
 * multimodal `content` array (text + `image_url` parts for reference images).
 * The proxy returns generated images on `choices[0].message.images[].image_url.url`
 * (typically a `data:` JPEG URL). Sync-only — no poll.
 */

export interface GeminiImageTransportSettings {
  apiKey: string
  /** OpenAI-compatible base including `/v1` (e.g. `http://127.0.0.1:8317/v1`). */
  baseURL: string
  headers?: Record<string, string>
}

type ChatImageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

type ChatCompletionsImageResponse = {
  choices?: Array<{
    message?: {
      images?: Array<{ image_url?: { url?: string } }>
    }
  }>
}

class GeminiImageTransport implements ImageGenerationTransport {
  private apiKey: string
  private baseURL: string
  private headers: Record<string, string>

  constructor(settings: GeminiImageTransportSettings) {
    this.apiKey = settings.apiKey
    this.baseURL = withoutTrailingSlash(settings.baseURL) ?? settings.baseURL
    this.headers = settings.headers ?? {}
  }

  async submit(input: ImageGenerationSubmitInput): Promise<{ taskId?: string; imageUrls?: string[] }> {
    const prompt = input.prompt ?? ''
    const files = input.files ?? []

    const content: string | ChatImageContentPart[] =
      files.length === 0
        ? prompt
        : [
            { type: 'text', text: prompt },
            ...files.map((file) => ({
              type: 'image_url' as const,
              image_url: { url: fileToDataUrl(file) }
            }))
          ]

    const body = {
      model: input.modelId,
      messages: [{ role: 'user', content }]
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.headers
      },
      body: JSON.stringify(body),
      signal: input.signal
    })

    if (!response.ok) {
      const message = await readErrorMessage(response, 'Image generation failed')
      throw new Error(message)
    }

    const data = (await response.json()) as ChatCompletionsImageResponse
    const images = data.choices?.[0]?.message?.images ?? []
    const imageUrls = images
      .map((item) => item.image_url?.url)
      .filter((url): url is string => typeof url === 'string' && url.length > 0)

    if (imageUrls.length === 0) {
      throw new Error(
        `Image generation for '${input.modelId}' completed but returned no images on choices[0].message.images`
      )
    }

    return { imageUrls }
  }
}

export function createGeminiImageTransport(settings: GeminiImageTransportSettings): GeminiImageTransport {
  return new GeminiImageTransport(settings)
}

/**
 * Build the gemini-image chat/completions transport from openai-compatible
 * provider settings. Shared by the image-generation job's transport registry.
 */
export function buildGeminiImageTransport(settings: {
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
}): ImageGenerationTransport {
  if (!settings.baseURL) {
    throw new Error(
      'openai-compatible gemini-image transport requires a non-empty `baseURL` (e.g. http://127.0.0.1:8317/v1).'
    )
  }
  return createGeminiImageTransport({
    apiKey: settings.apiKey ?? '',
    baseURL: settings.baseURL,
    headers: settings.headers
  })
}

export type { GeminiImageTransport }
