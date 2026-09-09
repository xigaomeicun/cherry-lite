import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGeminiImageTransport } from '../gemini/geminiImageTransport'

/**
 * Covers the CLI Proxy gemini-image chat/completions one-shot transport:
 * prompt-only body, multimodal reference-image body, image extraction from
 * `choices[0].message.images`, missing-image error, abort, and sync-only shape.
 */
describe('GeminiImageTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const baseInput = {
    modelId: 'gemini-image',
    n: 1,
    size: undefined,
    seed: undefined,
    files: undefined,
    mask: undefined,
    providerParams: {}
  } as const

  it('posts a plain-string user message to /chat/completions and returns image data URLs', async () => {
    const transport = createGeminiImageTransport({
      apiKey: 'token',
      baseURL: 'http://127.0.0.1:8317/v1'
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                images: [{ image_url: { url: 'data:image/jpeg;base64,QUJD' } }]
              }
            }
          ]
        }),
        { status: 200 }
      )
    )

    const result = await transport.submit({
      ...baseInput,
      prompt: 'a fox in the snow'
    })

    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe('http://127.0.0.1:8317/v1/chat/completions')
    const init = call[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gemini-image',
      messages: [{ role: 'user', content: 'a fox in the snow' }]
    })
    expect(result).toEqual({ imageUrls: ['data:image/jpeg;base64,QUJD'] })
  })

  it('builds multimodal content when reference images are present', async () => {
    const transport = createGeminiImageTransport({
      apiKey: 'token',
      baseURL: 'http://127.0.0.1:8317/v1'
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,XYZ' } }] } }]
        }),
        { status: 200 }
      )
    )

    await transport.submit({
      ...baseInput,
      prompt: 'make it blue',
      files: [{ mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }] as never
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('gemini-image')
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'make it blue' },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${btoa(String.fromCharCode(1, 2, 3))}` }
      }
    ])
  })

  it('throws a clear error when the response has no images', async () => {
    const transport = createGeminiImageTransport({
      apiKey: 'token',
      baseURL: 'http://127.0.0.1:8317/v1'
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'no image' } }] }), { status: 200 })
    )

    await expect(transport.submit({ ...baseInput, prompt: 'a fox' })).rejects.toThrow(
      /returned no images on choices\[0\]\.message\.images/
    )
  })

  it('throws the remote error message on a non-ok response', async () => {
    const transport = createGeminiImageTransport({
      apiKey: 'token',
      baseURL: 'http://127.0.0.1:8317/v1'
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'model unavailable' } }), { status: 500 })
    )

    await expect(transport.submit({ ...baseInput, prompt: 'a fox' })).rejects.toThrow('model unavailable')
  })

  it('forwards the abort signal to fetch', async () => {
    const transport = createGeminiImageTransport({
      apiKey: 'token',
      baseURL: 'http://127.0.0.1:8317/v1'
    })
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        ;(init?.signal as AbortSignal)?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    })

    const promise = transport.submit({
      ...baseInput,
      prompt: 'a fox',
      signal: controller.signal
    })
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal)
  })

  it('does not expose polling for the single-shot path', () => {
    const transport = createGeminiImageTransport({
      apiKey: 'token',
      baseURL: 'http://127.0.0.1:8317/v1'
    })
    expect('poll' in transport).toBe(false)
  })
})
