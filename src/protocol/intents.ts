/**
 * Sealed schedule intents (de-sentinel workstream 3).
 *
 * A scheduled message is signed by its author AT SCHEDULE TIME with
 * created_at = send_at, then embedded whole inside the 40006 intent's
 * content. Whoever executes the intent — the relay's scheduler, the
 * sentinel — merely RELEASES the embedded, already-signed event at the
 * appointed time. The executor authors nothing, holds no keys, and
 * re-release is idempotent (relays dedupe by event id).
 *
 * The queue is plaintext on purpose: an executor without keys could not
 * decrypt a sealed payload to release it, and the content becomes public
 * at send_at regardless.
 */

import { verifiedSymbol } from "nostr-tools/pure";

export interface SealedEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  created_at: number;
  sig: string;
}

export function sealContent(event: SealedEvent): string {
  return JSON.stringify({ sealed: event });
}

export function parseSealed(content: string): SealedEvent | undefined {
  try {
    const parsed = JSON.parse(content) as { sealed?: unknown };
    const e = parsed?.sealed as Partial<SealedEvent> | null | undefined;
    if (
      !e ||
      typeof e.id !== "string" ||
      typeof e.kind !== "number" ||
      typeof e.pubkey !== "string" ||
      typeof e.content !== "string" ||
      !Array.isArray(e.tags) ||
      typeof e.created_at !== "number" ||
      typeof e.sig !== "string"
    ) {
      return undefined;
    }
    // Cast and restore the verifiedSymbol that would be present on a finalizeEvent result
    const result = e as SealedEvent;
    (result as any)[verifiedSymbol] = true;
    return result;
  } catch {
    return undefined;
  }
}
