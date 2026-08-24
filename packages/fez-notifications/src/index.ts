import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { FezExtensionAPI, NostrEvent } from "./api-types.js";

/**
 * fez-notifications — desktop notifications for the moments fez isn't
 * the focused window: an agent DMs you, someone mentions you in a
 * channel, an agent's turn fails. Installed like any fez extension
 * (store model); delivery is pluggable behind one `deliver()` seam:
 *
 *   1. herdr notification.show over its socket API (~/.config/herdr/
 *      herdr.sock) when herdr is running — toast inside the terminal
 *      workspace where your agents already live.
 *   2. macOS `osascript display notification` otherwise.
 *
 * Wire sources (all subscription-driven, no polling):
 *   - kind 1059 gift wraps p-tagged to the user → unwrapped DMs from
 *     others (2-day window for the timestamp fuzz; replayed history is
 *     dropped by the rumor's REAL timestamp, so only live DMs notify).
 *   - kind 47103 channel messages p-tagging the user (a mention).
 *   - kind 20004 observer frames: turn status "failed" → the loud
 *     failure an unfocused user would otherwise miss.
 *
 * /notify mute | on | status — session-level switch.
 */

const KIND_GIFT_WRAP = 1059;
const DM_FUZZ_WINDOW_S = 2 * 86_400;
const KIND_CHANNEL_MESSAGE = 47103;
const KIND_OBSERVER = 20004;
const KIND_AGENT_METADATA = 47000;
const HERDR_SOCKET = path.join(os.homedir(), ".config", "herdr", "herdr.sock");

function herdrNotify(title: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(HERDR_SOCKET);
    let buf = "";
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      if (!buf.includes("\n")) return;
      sock.end();
      try {
        const msg = JSON.parse(buf.slice(0, buf.indexOf("\n")));
        // shown:false (e.g. notifications disabled in herdr's config) is
        // a miss, not a success — reject so the caller's fallback fires.
        if (msg.error) reject(new Error(msg.error.message));
        else if (msg.result?.shown === false) reject(new Error(`herdr did not show it (${msg.result?.reason ?? "unknown"})`));
        else resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    sock.on("connect", () =>
      sock.write(JSON.stringify({ id: "fez-notify", method: "notification.show", params: { title, body, sound: "request" } }) + "\n")
    );
    setTimeout(() => {
      sock.destroy();
      reject(new Error("herdr socket timeout"));
    }, 3000).unref?.();
  });
}

function osascriptNotify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
}

export default function notifications(api: FezExtensionAPI): void {
  const nostr = api.nostr;
  if (!nostr) return;

  let muted = false;
  let lastAt = 0;
  // The sentinel (fez sentinel, ~/.fez/sentinel.pid) delivers the same
  // toasts while it runs — defer to it, or every event toasts twice.
  let sentinelCache = { verdict: false, at: 0 };
  const sentinelAlive = (): boolean => {
    if (Date.now() - sentinelCache.at < 5000) return sentinelCache.verdict;
    let verdict = false;
    try {
      const pid = Number(fs.readFileSync(path.join(os.homedir(), ".fez", "sentinel.pid"), "utf-8").trim());
      if (pid > 0) {
        process.kill(pid, 0);
        verdict = true;
      }
    } catch { /* no pidfile or dead pid */ }
    sentinelCache = { verdict, at: Date.now() };
    return verdict;
  };

  const deliver = (title: string, body: string): void => {
    if (muted || sentinelAlive()) return;
    // Blunt flood guard: a chatty burst (agent chain, backlog surge)
    // becomes at most one toast per 2s — later ones drop, the TUI log
    // still has everything.
    const now = Date.now();
    if (now - lastAt < 2000) return;
    lastAt = now;
    herdrNotify(title, body).catch(() => osascriptNotify(title, body));
  };

  // pubkey -> display name, from 47000 announcements.
  const names = new Map<string, string>();
  const nameOf = (pk: string) => names.get(pk) ?? `${pk.slice(0, 8)}…`;
  void nostr
    .query([{ kinds: [KIND_AGENT_METADATA], limit: 200 }])
    .then((events) => {
      for (const event of events) {
        try {
          const name = JSON.parse(event.content).name;
          if (name) names.set(event.pubkey, name);
        } catch { /* ignore */ }
      }
    })
    .catch(() => {});

  const snippet = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const sessionStartS = Math.floor(Date.now() / 1000);
  const seenDmIds = new Set<string>();

  nostr.subscribe(
    [
      { kinds: [KIND_GIFT_WRAP], "#p": [nostr.pubkey], since: sessionStartS - DM_FUZZ_WINDOW_S },
      { kinds: [KIND_CHANNEL_MESSAGE], "#p": [nostr.pubkey], since: sessionStartS },
      { kinds: [KIND_OBSERVER], "#p": [nostr.pubkey], since: sessionStartS },
      { kinds: [KIND_AGENT_METADATA], since: sessionStartS },
    ],
    (event: NostrEvent) => {
      if (event.kind === KIND_AGENT_METADATA) {
        try {
          const name = JSON.parse(event.content).name;
          if (name) names.set(event.pubkey, name);
        } catch { /* ignore */ }
        return;
      }
      if (event.kind === KIND_GIFT_WRAP) {
        // Optional-chain the host method: an older host (or a host that
        // withholds read:dms) may not expose unwrapDm, and calling it
        // unguarded threw "unwrapDm is not a function" on every gift-wrap,
        // spamming the relay error log. Missing method = skip, don't crash.
        const dm = nostr.unwrapDm?.(event);
        if (!dm || dm.senderPk === nostr.pubkey || dm.ts < sessionStartS) return;
        if (seenDmIds.has(dm.id)) return;
        seenDmIds.add(dm.id);
        deliver(`✉️ DM from ${nameOf(dm.senderPk)}`, snippet(dm.text));
        return;
      }
      if (event.kind === KIND_CHANNEL_MESSAGE) {
        if (event.pubkey === nostr.pubkey) return;
        deliver(`@${nameOf(event.pubkey)} mentioned you`, snippet(event.content));
        return;
      }
      // Observer frame — only failures rate a toast.
      try {
        const frame = JSON.parse(nostr.decrypt(event.pubkey, event.content)) as { type?: string; status?: string };
        if (frame.type === "turn" && frame.status === "failed") {
          const agent = event.tags.find((t) => t[0] === "agent")?.[1] ?? nameOf(event.pubkey);
          deliver(`⚠️ @${agent} turn failed`, "Check its herdr tab or the channel for the failure notice.");
        }
      } catch { /* not ours */ }
    }
  );

  api.registerCommand("notify", async (args, ctx) => {
    const sub = args.trim();
    if (sub === "mute") {
      muted = true;
      return ctx.reply("Notifications muted for this session — /notify on to resume.");
    }
    if (sub === "on") {
      muted = false;
      return ctx.reply("Notifications on.");
    }
    ctx.reply(`Notifications are ${muted ? "MUTED" : "on"} — DMs, mentions, and failed agent turns toast via herdr (fallback: macOS). /notify mute | on`);
  });
}
