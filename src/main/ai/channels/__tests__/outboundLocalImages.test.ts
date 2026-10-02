import { describe, expect, it } from 'vitest'

import { extractOutboundLocalImages } from '../outboundLocalImages'

describe('extractOutboundLocalImages', () => {
  it('extracts markdown absolute image paths and strips them from the body', () => {
    const text = 'Here is the chart:\n\n![/Users/me/ws/out.png](/Users/me/ws/out.png)\n\nDone.'
    const { cleanedText, imagePaths } = extractOutboundLocalImages(text)
    expect(imagePaths).toEqual(['/Users/me/ws/out.png'])
    expect(cleanedText).toBe('Here is the chart:\n\nDone.')
    expect(cleanedText).not.toContain('/Users/me/ws/out.png')
  })

  it('extracts relative markdown image paths', () => {
    const text = 'See ![shot](./assets/shot.jpg) please'
    const { cleanedText, imagePaths } = extractOutboundLocalImages(text)
    expect(imagePaths).toEqual(['./assets/shot.jpg'])
    expect(cleanedText).toBe('See  please')
  })

  it('extracts a standalone absolute path line (image_delivery=path)', () => {
    const text = 'Result:\n\n/tmp/workspace/a.webp\n\nThanks'
    const { cleanedText, imagePaths } = extractOutboundLocalImages(text)
    expect(imagePaths).toEqual(['/tmp/workspace/a.webp'])
    expect(cleanedText).toBe('Result:\n\nThanks')
  })

  it('deduplicates while preserving first-seen order', () => {
    const text = ['![a](/ws/a.png)', '![b](/ws/b.jpeg)', '![a again](/ws/a.png)', '/ws/b.jpeg'].join('\n')
    const { imagePaths } = extractOutboundLocalImages(text)
    expect(imagePaths).toEqual(['/ws/a.png', '/ws/b.jpeg'])
  })

  it('ignores non-image extensions and remote/data URLs', () => {
    const text = [
      '![doc](/ws/report.pdf)',
      '![remote](https://example.com/x.png)',
      '![data](data:image/png;base64,aaa)',
      '![file](file:///ws/x.png)',
      '![ok](/ws/ok.gif)'
    ].join('\n')
    const { cleanedText, imagePaths } = extractOutboundLocalImages(text)
    expect(imagePaths).toEqual(['/ws/ok.gif'])
    expect(cleanedText).toContain('/ws/report.pdf')
    expect(cleanedText).toContain('https://example.com/x.png')
    expect(cleanedText).toContain('data:image/png;base64,aaa')
    expect(cleanedText).toContain('file:///ws/x.png')
    expect(cleanedText).not.toContain('/ws/ok.gif')
  })

  it('ignores bare relative path lines without markdown', () => {
    const text = 'assets/foo.png'
    const { cleanedText, imagePaths } = extractOutboundLocalImages(text)
    expect(imagePaths).toEqual([])
    expect(cleanedText).toBe('assets/foo.png')
  })

  it('returns original text when nothing matches', () => {
    const text = 'No images here.'
    expect(extractOutboundLocalImages(text)).toEqual({
      cleanedText: 'No images here.',
      imagePaths: []
    })
  })

  it('supports optional title in markdown image syntax', () => {
    const text = '![alt](/ws/pic.png "caption")'
    const { cleanedText, imagePaths } = extractOutboundLocalImages(text)
    expect(imagePaths).toEqual(['/ws/pic.png'])
    expect(cleanedText).toBe('')
  })
})
