export const BUILTIN_AGENT_ROLE = {
  ASSISTANT: 'assistant',
  SUPPORT: 'support',
  DOCTOR: 'doctor'
} as const

export const CHERRY_SUPPORT_AGENT_ID = 'cherry-support'

export type BuiltinAgentRole = (typeof BUILTIN_AGENT_ROLE)[keyof typeof BUILTIN_AGENT_ROLE]

export function isProtectedBuiltinAgentRole(role: unknown): role is BuiltinAgentRole {
  return Object.values(BUILTIN_AGENT_ROLE).includes(role as BuiltinAgentRole)
}

/**
 * Builtin roles the delete flow must refuse or downgrade to sessions-only.
 * Assistant and Support delete like any other Agent — the tombstone in
 * `builtinAgentTombstone.ts` keeps them deleted — while the Doctor Agent is a
 * sealed System Doctor internal and stays protected.
 */
export function isDeletionProtectedBuiltinAgentRole(role: unknown): boolean {
  return role === BUILTIN_AGENT_ROLE.DOCTOR
}

/** Agents whose runtime ignores user-installed skills and only loads the skills bundled with them. */
export function isSealedBuiltinAgentRole(role: unknown): boolean {
  return role === BUILTIN_AGENT_ROLE.SUPPORT || role === BUILTIN_AGENT_ROLE.DOCTOR
}
