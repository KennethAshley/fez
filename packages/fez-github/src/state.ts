import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Item } from "./github.js";

/**
 * What the bridge remembers between polls — pure enough to test.
 *
 * Config says which repos to watch. State is the watermark: for each
 * item, what we last published and which message is its thread root.
 * Losing state means republishing a repo's recent history as if it were
 * new, so it is written rename-over-tmp rather than in place.
 */

export const CONFIG_FILE = path.join(os.homedir(), ".fez", "github.json");
export const STATE_FILE = path.join(os.homedir(), ".fez", "github-state.json");

export interface Config {
  repos: string[];
  /** Floor of 60s — this polls a third-party API on someone else's quota. */
  pollSeconds?: number;
}

export interface Seen {
  /** On the repo marker: prevents roots from following a watch to another channel. */
  channelId?: string;
  updatedAt: string;
  state: string;
  merged?: boolean;
  comments: number;
  /** Last check rollup published, so an unchanged one doesn't repeat. */
  checks?: string;
  /** The message that is this item's thread root. */
  rootId: string;
}

export type State = Record<string, Seen>;

export const keyFor = (repo: string, number: number): string => `${repo}#${number}`;

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(value, null, 1), "utf-8");
  await fs.rename(tmp, file);
}

/**
 * What to say about an item we have seen before — or undefined when
 * nothing worth a message changed.
 *
 * `updated_at` moves for reasons nobody wants a line about: a label, an
 * assignee, a rebase. So a change is reported only when the item's STATE
 * moved, or its checks did. Comment counts ride along on those lines
 * rather than generating their own, because one message per comment
 * would make the thread noisier than the pull request it describes.
 */
export function changeLine(before: Seen, now: Item, checks?: string): string | undefined {
  const bits: string[] = [];
  if (now.merged && !before.merged) bits.push("merged");
  else if (now.state !== before.state) bits.push(now.state === "closed" ? "closed" : "reopened");
  if (checks && checks !== before.checks) bits.push(checks);
  if (bits.length === 0) return undefined;
  const newComments = now.comments - before.comments;
  const extra = newComments > 0 ? ` · ${newComments} new comment${newComments === 1 ? "" : "s"}` : "";
  return bits.join(" · ") + extra;
}
