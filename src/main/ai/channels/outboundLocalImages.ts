/**
 * Extract local image paths from channel outbound markdown so IM adapters can
 * upload them (e.g. Telegram sendPhoto) and strip the path text from the body.
 *
 * Supports:
 * - `![alt](path)` markdown images with image extensions
 * - A whole line that is an absolute image path (image_delivery=path)
 *
 * Does NOT fetch http(s)/data/file URLs — those stay in the text for the
 * platform formatter. Path authorization happens later via resolveWorkspaceFile.
 */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** Markdown image: ![alt](path) or ![alt](path "title") */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

/**
 * A full line that is only an absolute filesystem image path (Unix or Windows).
 * Relative bare paths are ignored — too ambiguous without markdown markup.
 */
const ABS_PATH_LINE_RE = /^(?:\/[^\s]+|([A-Za-z]:[\\/][^\s]+))\.(?:png|jpe?g|gif|webp)[ \t]*$/gim

export type OutboundLocalImages = {
  /** Text with extracted local-image markdown / path lines removed. */
  cleanedText: string
  /** Deduplicated image paths in first-seen order. */
  imagePaths: string[]
}

function extensionOf(filePath: string): string {
  const bare = filePath.split(/[?#]/)[0] ?? filePath
  const dot = bare.lastIndexOf('.')
  if (dot < 0) return ''
  return bare.slice(dot).toLowerCase()
}

function isLocalImagePath(raw: string): boolean {
  const p = raw.trim()
  if (!p) return false
  // Remote / data / file-scheme URLs are not local disk paths for upload.
  if (/^(?:https?:|data:|file:)/i.test(p)) return false
  return IMAGE_EXTS.has(extensionOf(p))
}

function remember(path: string, seen: Set<string>, out: string[]): void {
  if (seen.has(path)) return
  seen.add(path)
  out.push(path)
}

/**
 * Pull local image paths out of a final assistant markdown string and return
 * the body with those references removed (so TG users don't see raw paths).
 */
export function extractOutboundLocalImages(text: string): OutboundLocalImages {
  const seen = new Set<string>()
  const imagePaths: string[] = []

  let cleaned = text.replace(MD_IMAGE_RE, (match, _alt: string, rawPath: string) => {
    const p = rawPath.trim()
    if (!isLocalImagePath(p)) return match
    remember(p, seen, imagePaths)
    return ''
  })

  cleaned = cleaned.replace(ABS_PATH_LINE_RE, (match) => {
    const p = match.trim()
    if (!isLocalImagePath(p)) return match
    remember(p, seen, imagePaths)
    return ''
  })

  cleaned = cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { cleanedText: cleaned, imagePaths }
}
