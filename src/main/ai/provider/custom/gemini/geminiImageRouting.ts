/**
 * Model-id gate for CLI Proxy / OpenAI-compatible "chat 出图" via
 * `POST /v1/chat/completions` (model `gemini-image`).
 *
 * Only this exact id (and any in-app aliases listed below) should leave the
 * stock OpenAI-compatible `/images/generations` path — do not match the broader
 * `gemini-*-image` family (those use Google-native image adapters on google /
 * aihubmix / dmxapi / gateway).
 */
const GEMINI_CHAT_IMAGE_MODEL_IDS = new Set(['gemini-image'])

export function geminiImageUsesChatCompletions(modelId: string): boolean {
  return GEMINI_CHAT_IMAGE_MODEL_IDS.has(modelId)
}
