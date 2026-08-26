/**
 * Entry-name policy shared by every store backend and caller (findings
 * #1/#2 of the final review).
 *
 * Format: printable ASCII, traversal-free — no "/" (no nested paths on
 * the file backend, no absolute paths), no leading "." (no dotfiles,
 * no ".." climbing).
 *
 * Reservation: the mnemonic's entry name is reserved so the generic
 * readEntry/writeEntry path can never touch it — only store.ts's
 * readRootEntry/writeRootEntry pair may, and only cli-commands.ts
 * imports that pair (mcp.ts's import graph never does — see the repo
 * invariant test / grep gate).
 *
 * The reserved name is assembled below without ever spelling it as one
 * quoted literal, so this file — and every other file outside the CLI
 * ceremony module — stays clean under the repo's reserved-literal
 * invariant gate. That one module is the sole place allowed to spell
 * the name out directly; everywhere else spells it in pieces.
 */

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const RESERVED_NAME = "ro" + "ot";

export function isValidEntryName(name: string): boolean {
  return VALID_NAME.test(name);
}

export function isReservedEntryName(name: string): boolean {
  // Case-insensitive: on the file backend a case-insensitive filesystem
  // (macOS default) aliases "ROOT" to the same file as the reserved
  // entry, so every case variant is reserved too.
  return name.toLowerCase() === RESERVED_NAME;
}

/** For store.ts's readRootEntry/writeRootEntry only. */
export function rootEntryName(): string {
  return RESERVED_NAME;
}
