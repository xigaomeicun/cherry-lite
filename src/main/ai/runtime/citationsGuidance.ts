/**
 * Runtime-neutral inline-citation guidance for agent sessions, appended to the system prompt
 * only for the lookup tools the agent can actually call (web unless the user
 * disabled both cherry-tools web lookups; kb only when the resolved knowledge
 * scope is non-empty — a static binding or a per-turn composer selection).
 * Mirrors the assistant-path `CITATIONS_SYSTEM_PROMPT`
 * (`../aiSdk/prompts/citations.ts`); the `[cite:id]` markers are resolved by
 * the renderer against the tool results of the message and earlier turns.
 */

import { toCherryBuiltinRuntimeName } from '@main/ai/toolApproval/builtinToolPolicy'
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '@shared/ai/builtinTools'

// The agent calls these tools under their cherry-tools runtime names, so that is what the prompt
// must quote — the bare `web_search` would not match anything it can invoke.
const CHERRY_WEB_SEARCH_RUNTIME_NAME = toCherryBuiltinRuntimeName(WEB_SEARCH_TOOL_NAME)
const CHERRY_WEB_FETCH_RUNTIME_NAME = toCherryBuiltinRuntimeName(WEB_FETCH_TOOL_NAME)

export interface CitationsGuidanceOptions {
  web: boolean
  /**
   * Ignored in cherry-lite: the kb_* lookup tools were removed together with the knowledge-base
   * feature, so the prompt must never point the model at them. Kept so callers stay unchanged.
   */
  kb: boolean
}

export function buildCitationsGuidance({ web }: CitationsGuidanceOptions): string | undefined {
  if (!web) return undefined
  const tools = `\`${CHERRY_WEB_SEARCH_RUNTIME_NAME}\` / \`${CHERRY_WEB_FETCH_RUNTIME_NAME}\``
  return `## Citations

Results from ${tools} each carry an \`id\` field. When a statement in your reply is based on one of those results, append a citation marker immediately after it: [cite:ID] with the exact id (e.g. "Prices rose 3% in June. [cite:3f2a1b9c-2]"). Chain markers when several results support one statement: [cite:3f2a1b9c-1][cite:7d4e0a51-3]. Copy ids exactly — never invent or renumber them — and do not add a "References" or "Sources" section: the app renders citations from the inline markers.`
}
