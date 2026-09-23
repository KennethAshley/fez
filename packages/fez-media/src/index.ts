import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FezExtensionAPI } from "./api-types.js";
import type { FezClient } from "@fezchat/client";
import { mimeFor, uploadToBlossom } from "./blossom.js";

/**
 * fez-media — file sharing for fez, the store-model way:
 * /upload pushes a file to a Blossom server under a BUD-02 signed
 * authorization and drops the content-addressed URL into the current
 * channel. The relay carries only the URL; the bytes live wherever the
 * user points FEZ_MEDIA_SERVER (or settings.json mediaServer) — public
 * server or self-hosted, fez doesn't care. Buzz runs media inside its
 * relay; fez keeps the relay byte-free.
 */

const DEFAULT_SERVER = "https://blossom.primal.net";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // Buzz's generic-file ceiling

function mediaServer(): string {
  if (process.env.FEZ_MEDIA_SERVER) return process.env.FEZ_MEDIA_SERVER;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".fez", "settings.json"), "utf-8"));
    if (typeof settings.mediaServer === "string" && settings.mediaServer) return settings.mediaServer;
  } catch { /* no settings — default below */ }
  return DEFAULT_SERVER;
}

const human = (n: number) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;

export default function media(api: FezExtensionAPI): void {
  // Both seams are optional on the real API and undefined outside the
  // TUI/sentinel. Uploading means signing, so without `nostr` there is
  // no degraded mode worth offering — bail before registering anything,
  // the same way a missing client already did. Captured in a local so
  // the narrowing survives into the async command handler.
  if (!api.client || !api.nostr) return;
  const client = api.client as FezClient;
  const nostr = api.nostr;

  api.registerCommand("upload", async (args, ctx) => {
    const trimmed = args.trim();
    if (!trimmed) {
      return ctx.reply(
        `Usage: /upload <file path> [caption] — pushes the file to ${mediaServer()} (FEZ_MEDIA_SERVER or settings.json mediaServer to change) and shares the link here.`
      );
    }
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join one first, then /upload.");

    // First token = path (support ~); the rest is the caption.
    const [rawPath, ...captionParts] = trimmed.split(/\s+/);
    const filePath = path.resolve(rawPath.replace(/^~(?=$|\/)/, os.homedir()));
    const caption = captionParts.join(" ");

    let bytes: Uint8Array;
    try {
      bytes = fs.readFileSync(filePath);
    } catch {
      return ctx.reply(`Can't read ${filePath} — check the path.`);
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return ctx.reply(`That's ${human(bytes.length)} — the cap is ${human(MAX_UPLOAD_BYTES)}.`);
    }

    const name = path.basename(filePath);
    const server = mediaServer();
    ctx.reply(`⬆ uploading ${name} (${human(bytes.length)}) to ${server}…`);
    try {
      const blob = await uploadToBlossom(server, bytes, mimeFor(name), (tmpl) => nostr.signEvent(tmpl));
      const line = `${caption ? `${caption}\n` : ""}📎 ${name} (${human(blob.size)}) ${blob.url}`;
      await client.sendChannelMessage(line); // scoped to the current channel
      api.ui.appendMessage("You", line); // local echo — the relay copy is deduped as ours
      ctx.reply(`✅ shared — content-addressed at ${blob.sha256.slice(0, 12)}…`);
    } catch (err) {
      ctx.reply(`❌ upload failed: ${err instanceof Error ? err.message : err}`);
    }
  });
}
