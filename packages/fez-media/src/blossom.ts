import { createHash } from "node:crypto";

/**
 * Blossom (BUD-02) upload — the decentralized media half fez was missing:
 * the CLIENT signs a kind-24242 authorization naming the
 * blob's sha256, any Blossom server verifies and stores, and the relay
 * never sees a byte. Buzz runs its own media pipeline inside the relay;
 * fez points at whichever server the user brings (public or self-hosted)
 * — same bring-your-own posture as relay storage.
 */

export const KIND_BLOSSOM_AUTH = 24242;

export interface SignedEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface BlossomUpload {
  url: string;
  sha256: string;
  size: number;
  type?: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Upload a blob. `sign` is the extension seam's signEvent — the key never
 * enters this module. Auth (BUD-02): kind 24242, t=upload, x=sha256 of
 * the exact bytes, short expiration; base64-encoded into the
 * Authorization header.
 */
export async function uploadToBlossom(
  server: string,
  bytes: Uint8Array,
  mime: string,
  sign: (tmpl: { kind: number; tags: string[][]; content: string }) => SignedEvent
): Promise<BlossomUpload> {
  const hash = sha256Hex(bytes);
  const auth = sign({
    kind: KIND_BLOSSOM_AUTH,
    tags: [
      ["t", "upload"],
      ["x", hash],
      ["expiration", String(Math.floor(Date.now() / 1000) + 300)],
    ],
    content: "fez upload",
  });
  const base = server.replace(/\/+$/, "");
  const response = await fetch(`${base}/upload`, {
    method: "PUT",
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
      "Content-Type": mime,
    },
    body: bytes as unknown as RequestInit["body"],
  });
  if (!response.ok) {
    const reason = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Blossom upload failed (${response.status}): ${reason || response.statusText}`);
  }
  const body = (await response.json().catch(() => ({}))) as Partial<BlossomUpload>;
  return {
    url: body.url ?? `${base}/${hash}`,
    sha256: body.sha256 ?? hash,
    size: body.size ?? bytes.length,
    type: body.type ?? mime,
  };
}

/**
 * Extension → MIME. Exported because the desktop renderer keeps a
 * dependency-light mirror of the playable half of this table (the webview
 * can't import this package) and a test gates the two against each other.
 */
export const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
};

export function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
