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
  /** MIME type, when the browser knew it — what lets an agent runner
   * decide an attachment is an image worth fetching for vision. */
  type?: string;
  /** "WxH" for visual media the browser could measure. Carried so the
   * renderer can reserve the box before the bytes arrive; without it a
   * loading image or video shoves everything below it down the timeline. */
  dim?: string;
}

/**
 * Best-effort intrinsic size, for the imeta `dim` field.
 *
 * Purely so the receiving renderer can reserve the box before the bytes
 * land — a loading image or video with no reserved space shoves every
 * message below it down the timeline as it pops in. Never blocks the
 * upload: anything the browser can't decode inside the timeout simply
 * uploads without a dim, and the renderer falls back to its own max box.
 */
async function measure(file: File): Promise<string | undefined> {
  const kind = file.type.split("/")[0];
  if (kind !== "image" && kind !== "video") return undefined;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 3_000);
      const settle = (w: number, h: number) => {
        clearTimeout(timer);
        resolve(w > 0 && h > 0 ? `${w}x${h}` : undefined);
      };
      const fail = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
      if (kind === "image") {
        const image = new Image();
        image.onload = () => settle(image.naturalWidth, image.naturalHeight);
        image.onerror = fail;
        image.src = url;
      } else {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.onloadedmetadata = () => settle(video.videoWidth, video.videoHeight);
        video.onerror = fail;
        video.src = url;
      }
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadFile(
  wire: BrowserWire,
  file: File,
  onProgress?: (percent: number) => void
): Promise<Uploaded> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = bytesToHex(sha256(bytes));
  const auth = await wire.signEvent({
    kind: KIND_BLOSSOM_AUTH,
    tags: [
      ["t", "upload"],
      ["x", hash],
      ["expiration", String(Math.floor(Date.now() / 1000) + 300)],
    ],
    content: "fez upload",
  });
  const base = mediaServer().replace(/\/+$/, "");
  // XHR instead of fetch — it's the only way to get real upload progress.
  const body = await new Promise<{ url?: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${base}/upload`);
    xhr.setRequestHeader("Authorization", `Nostr ${btoa(JSON.stringify(auth))}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as { url?: string });
        } catch {
          resolve({});
        }
      } else {
        reject(new Error(`upload failed (${xhr.status}): ${xhr.responseText.slice(0, 200) || xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error("upload failed — network error"));
    xhr.send(bytes);
  });
  return {
    url: body.url ?? `${base}/${hash}`,
    name: file.name,
    size: bytes.length,
    type: file.type || undefined,
    dim: await measure(file),
  };
}

/** NIP-92 media tag — structured twin of the share line, for machines. */
export function imetaTag(upload: Uploaded): string[] {
  return [
    "imeta",
    `url ${upload.url}`,
    ...(upload.type ? [`m ${upload.type}`] : []),
    `size ${upload.size}`,
    ...(upload.dim ? [`dim ${upload.dim}`] : []),
  ];
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
