import { open, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { zstdDecompressSync } from 'node:zlib'

import { loggerService } from '@logger'

const logger = loggerService.withContext('retiredDshSummary')
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** The last `compaction/summary` entry DSH persisted for one conversation. */
export interface RetiredDshCompactionSummary {
  compactionId: string
  /** Epoch ms at which DSH persisted the summary (the end of the compaction). */
  time: number
  text: string
  /** `shadowedTokenCount`: the context size DSH compacted away. */
  preTokens?: number
  /** `usage.outputTokens`: the size of the generated summary. */
  postTokens?: number
  dshSessionId: string
}

const ZSTD_MAGIC = 0xfd2fb528
const YIELD_EVERY_FRAMES = 64

/** Byte length of the zstd frame at `offset` (RFC 8878 §3.1). DSH appends one frame per flush. */
function zstdFrameLength(buffer: Buffer, offset: number): number {
  const magic = buffer.readUInt32LE(offset)
  if ((magic & 0xfffffff0) === 0x184d2a50) return 8 + buffer.readUInt32LE(offset + 4) // skippable frame
  if (magic !== ZSTD_MAGIC) throw new Error(`Invalid zstd frame at byte ${offset}`)
  const descriptor = buffer[offset + 4]
  const singleSegment = (descriptor >> 5) & 1
  const fcsFlag = descriptor >> 6
  let cursor =
    offset +
    5 +
    (singleSegment ? 0 : 1) +
    [0, 1, 2, 4][descriptor & 3] +
    (fcsFlag === 0 ? singleSegment : [0, 2, 4, 8][fcsFlag])
  for (;;) {
    const header = buffer.readUIntLE(cursor, 3)
    const type = (header >> 1) & 3
    if (type === 3) throw new Error(`Reserved zstd block type at byte ${cursor}`)
    cursor += 3 + (type === 1 ? 1 : header >> 3)
    if (header & 1) break
  }
  if ((descriptor >> 2) & 1) cursor += 4
  if (cursor > buffer.length) throw new Error('Truncated zstd frame')
  return cursor - offset
}

/**
 * Line reader over a multi-frame zstd file. Node's zstd decoder stops after the first frame, so
 * each frame is decoded on its own (bounded memory per frame; yields to the event loop).
 */
async function* zstdLines(file: string): AsyncGenerator<string> {
  const buffer = await readFile(file)
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let frames = 0
  for (let offset = 0; offset < buffer.length;) {
    const length = zstdFrameLength(buffer, offset)
    const magic = buffer.readUInt32LE(offset)
    if (magic === ZSTD_MAGIC) {
      pending += decoder.write(zstdDecompressSync(buffer.subarray(offset, offset + length)))
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (line) yield line
    }
    offset += length
    if (++frames % YIELD_EVERY_FRAMES === 0) await new Promise((resolve) => setImmediate(resolve))
  }
  pending += decoder.end()
  if (pending) yield pending
}

function textOf(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : ''
  return value
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .filter(Boolean)
    .join('\n\n')
}

/** Reads only the leading frame(s) — enough for the `session` header line. */
async function readHeaderCwd(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r')
  try {
    for (let size = 64 * 1024; size <= 16 * 1024 * 1024; size *= 4) {
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, 0)
      const chunk = buffer.subarray(0, bytesRead)
      let text = ''
      for (let offset = 0; offset < chunk.length;) {
        let length: number
        try {
          length = zstdFrameLength(chunk, offset)
        } catch (error) {
          if (bytesRead < size) throw error
          break // frame continues past this read; retry with a larger one
        }
        if (chunk.readUInt32LE(offset) === ZSTD_MAGIC)
          text += zstdDecompressSync(chunk.subarray(offset, offset + length)).toString('utf8')
        offset += length
        const newline = text.indexOf('\n')
        if (newline >= 0) text = text.slice(0, newline)
        if (newline >= 0 || offset >= chunk.length) {
          const header = JSON.parse(text) as { type?: string; cwd?: unknown }
          return header.type === 'session' && typeof header.cwd === 'string' ? header.cwd : undefined
        }
      }
      if (bytesRead < size) return undefined
    }
    return undefined
  } finally {
    await handle.close()
  }
}

async function readLastSummary(file: string, dshSessionId: string): Promise<RetiredDshCompactionSummary | undefined> {
  let last: RetiredDshCompactionSummary | undefined
  for await (const line of zstdLines(file)) {
    // Tool results make some lines megabytes long; only parse the few summary entries.
    if (!line.includes('"compaction/summary"')) continue
    const entry = JSON.parse(line) as { type?: string; time?: unknown; data?: Record<string, unknown> }
    if (entry.type !== 'compaction/summary' || !entry.data || typeof entry.time !== 'number') continue
    const text = textOf(entry.data.summary) || textOf(entry.data.rawOutput)
    if (!text.trim()) continue
    const usage = entry.data.usage as { outputTokens?: unknown } | undefined
    last = {
      compactionId: String(entry.data.compactionId ?? ''),
      time: entry.time,
      text,
      preTokens: typeof entry.data.shadowedTokenCount === 'number' ? entry.data.shadowedTokenCount : undefined,
      postTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined,
      dshSessionId
    }
  }
  return last
}

/**
 * Find the retired DSH session file(s) whose header `cwd` is this Cherry session's workspace and
 * return the newest compaction summary among them. Read-only; never calls a model.
 */
export async function readRetiredDshCompactionSummary(
  dshSessionsRoot: string,
  workspacePath: string,
  preferredIds: ReadonlySet<string> = new Set()
): Promise<RetiredDshCompactionSummary | undefined> {
  let groups: string[]
  try {
    groups = await readdir(dshSessionsRoot)
  } catch {
    return undefined
  }
  let best: RetiredDshCompactionSummary | undefined
  for (const group of groups) {
    let ids: string[]
    try {
      ids = await readdir(path.join(dshSessionsRoot, group))
    } catch {
      continue
    }
    for (const id of ids) {
      const file = path.join(dshSessionsRoot, group, id, SESSION_FILE)
      try {
        if ((await readHeaderCwd(file)) !== workspacePath) continue
        const summary = await readLastSummary(file, id)
        if (!summary) continue
        if (
          !best ||
          summary.time > best.time ||
          (summary.time === best.time && preferredIds.has(id) && !preferredIds.has(best.dshSessionId))
        )
          best = summary
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR')
          logger.warn('Unreadable retired DSH session file', { file, error })
      }
    }
  }
  return best
}
