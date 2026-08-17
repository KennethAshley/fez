import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BrowserWire } from "./wire";

/**
 * Blossom (BUD-02) upload from the webview — the same protocol as
 * fez-media's /upload (kind 24242 auth naming the blob's sha256), minus
 * node:crypto and Buffer. The GUI drags a file in; the relay never sees
 * a byte; the share line it produces is the exact format fez-media
 * emits, so every fez surface renders it the same way.
 */

const KIND_BLOSSOM_AUTH = 24242;

export function mediaServer(): string {
  return localStorage.getItem("fez-media-server") ?? "https://blossom.primal.net";
}

export interface Uploaded {
  url: string;
  name: string;
  size: number;
}

export async function uploadFile(wire: BrowserWire, file: File): Promise<Uploaded> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = bytesToHex(sha256(bytes));
  const auth = wire.signEvent({
    kind: KIND_BLOSSOM_AUTH,
    tags: [
      ["t", "upload"],
      ["x", hash],
      ["expiration", String(Math.floor(Date.now() / 1000) + 300)],
    ],
    content: "fez upload",
  });
  const base = mediaServer().replace(/\/+$/, "");
  const response = await fetch(`${base}/upload`, {
    method: "PUT",
    headers: {
      Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: bytes,
  });
  if (!response.ok) {
    const reason = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`upload failed (${response.status}): ${reason || response.statusText}`);
  }
  const body = (await response.json().catch(() => ({}))) as { url?: string };
  return { url: body.url ?? `${base}/${hash}`, name: file.name, size: bytes.length };
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** fez-media's share line — one format for every surface. */
export function shareLine(upload: Uploaded): string {
  return `📎 ${upload.name} (${humanSize(upload.size)}) ${upload.url}`;
}
