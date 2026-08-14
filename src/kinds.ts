/**
 * Fez event kind registry.
 * Agents communicate via standard Nostr events with these kind numbers.
 */

export const KIND_AGENT_METADATA = 47000;
export const KIND_AGENT_TASK = 47001;
export const KIND_AGENT_PROGRESS = 47002;
export const KIND_AGENT_RESULT = 47003;
export const KIND_AGENT_DM = 47004;
export const KIND_AGENT_CAPABILITY = 47005;
export const KIND_AGENT_DELEGATION = 47010;
export const KIND_AGENT_REVOKE = 47011;
export const KIND_AGENT_CANCEL = 47012;
export const KIND_AGENT_AUDIT = 47020;

export const AGENT_KINDS = [
  KIND_AGENT_METADATA,
  KIND_AGENT_TASK,
  KIND_AGENT_PROGRESS,
  KIND_AGENT_RESULT,
  KIND_AGENT_DM,
  KIND_AGENT_CAPABILITY,
  KIND_AGENT_DELEGATION,
  KIND_AGENT_REVOKE,
  KIND_AGENT_CANCEL,
  KIND_AGENT_AUDIT,
] as const;
