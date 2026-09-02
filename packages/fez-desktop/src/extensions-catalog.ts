import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { reloadGuiExtensions } from "./gui-extensions";

/**
 * The official fez extension catalog — one source for the browse gallery
 * and for @fez's in-chat install offers. Curated on purpose: an npm scope
 * search returns the infra libraries too, and a hand-kept set of the
 * packages a person would actually install is clearer than a filtered dump.
 */
export interface CatalogEntry {
  name: string;
  title: string;
  blurb: string;
  /** Where it shows up once installed — so "nothing happened" isn't a mystery. */
  where: string;
  permissions: string[];
  /** Source repo when it isn't a packages/ dir of the monorepo (e.g. bazaar). */
  repo?: string;
}

export const CATALOG: CatalogEntry[] = [
  { name: "@fezchat/git", title: "Git", blurb: "Host repositories on the relay — a repo is a channel, agents push as themselves, and merge is a button.", where: "Adds a Repos panel in Settings, and a board on repo threads.", permissions: ["ui", "commands", "read:channels", "publish", "background", "personas", "network:relay"] },
  { name: "@fezchat/kanban", title: "Kanban", blurb: "Boards on your docs — columns are headings, cards are checkboxes; agents move their own cards.", where: "Opens on any doc that's a board — use the ▦ board toggle in a doc.", permissions: ["ui", "read:channels", "publish"] },
  { name: "@fezchat/polls", title: "Polls", blurb: "Vote by reaction, tally in real time.", where: "Adds /poll to the composer; poll cards render under the message.", permissions: ["ui", "commands", "read:channels", "publish"] },
  { name: "@fezchat/github", title: "GitHub", blurb: "A window onto a GitHub repo — a pull request becomes a thread you can talk in.", where: "Adds /github and a GitHub settings panel.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
  { name: "@fezchat/obsidian", title: "Obsidian", blurb: "Export a channel's docs to your Obsidian vault.", where: "Adds /obsidian to the composer.", permissions: ["ui", "commands", "read:channels"] },
  { name: "@fezchat/live-blocks", title: "Live Blocks", blurb: "A markdown block an agent keeps breathing — live data that updates itself inside a doc.", where: "Renders live blocks inside docs.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
  { name: "@fezchat/themes", title: "Themes", blurb: "The classics — Dracula, Nord, Catppuccin, Solarized, Tokyo Night, Monokai, Night Owl, Kanagawa, Flexoki, and ten more. Each a light/dark pair.", where: "Adds a shelf of packs to Settings → theme.", permissions: ["ui"] },
  { name: "@fezchat/wallet", title: "Wallet", blurb: "Per-agent allowance wallets — HD-derived accounts from one master mnemonic, TAO live, threshold consent via owner-signed reactions. The balance IS the cap.", where: "Adds a wallet panel and the payment skill agents spend through.", permissions: ["network:.opentensor.ai", "network:.base.org", "network:relay", "publish", "read:channels", "ui", "processes"] },
  { name: "@fezchat/ridges", title: "Ridges", blurb: "Pay the Ridges subnet to fix a GitHub issue — /ridges <issue-url> escrows through the wallet's x402 rail and tracks the resulting PR.", where: "Adds /ridges and the bounty-rail pane; pays through your fez wallet.", permissions: ["network:product.ridges.ai", "network:api.github.com", "read:channels", "publish", "commands", "ui", "background"] },
  { name: "@fezchat/memory", title: "Memory", blurb: "Shared team memory for agents — fez_remember / fez_recall over append-only, signed events on the relay. Shared by default, because the relay is.", where: "Adds the fez_remember and fez_recall skills to granted agents.", permissions: ["read:channels", "publish"] },
  { name: "@fezchat/loom", title: "Loom", blurb: "Describe a tool over your channel data and @loom weaves a live, streaming UI — sandboxed; reads the relay freely, every write asks you first.", where: "Adds the Loom panel; kept artifacts live in the ▣ tools gallery.", permissions: ["read:channels", "publish", "personas", "ui"] },
  { name: "@fezchat/bazaar", title: "Bazaar", blurb: "The fez bazaar — run a miner that serves the subnet, watch how it's doing, and ask the market questions with bazaar_ask.", where: "Adds a Bazaar panel, the bazaar_ask skill, and the fez-bazaar-miner program.", permissions: ["network:.fez.chat", "read:channels", "ui", "processes", "notifications"], repo: "https://github.com/KennethAshley/fez-bazaar" },
  { name: "@fezchat/elevenlabs", title: "ElevenLabs", blurb: "Agents speak — ask any granted agent to say something and a voice note lands in the channel, in that agent's own stable voice.", where: "Adds the fez_speak skill; voice map in Settings → extensions.", permissions: ["network:api.elevenlabs.io", "network:relay", "publish", "read:channels", "ui"] },
];

export const PERM_LABEL: Record<string, string> = {
  ui: "add panels & views",
  commands: "add slash commands",
  "read:channels": "read your channels",
  publish: "post as you",
  "read:agents": "see agent activity",
  personas: "read & edit agent personas",
  background: "run background tasks",
  // Said as what it costs you, not as what the API is called: the point a
  // reader needs is that this outlives the window they grant it in.
  processes: "run its own programs on your machine",
  notifications: "send you native notifications",
  "network:relay": "talk to your relay",
};

export const SENSITIVE = new Set(["publish", "personas", "background", "processes"]);

/** Human label for a permission id — network:<host> ids get a real
 * sentence instead of falling through to raw code, since half the new
 * catalog entries (wallet, ridges, bazaar) declare them. */
export const permLabel = (p: string): string => {
  if (PERM_LABEL[p]) return PERM_LABEL[p];
  if (p.startsWith("network:")) {
    const host = p.slice("network:".length);
    return host === "*" ? "connect to ANY server" : `connect to ${host.replace(/^\./, "*.")}`;
  }
  return p;
};

const REPO = "https://github.com/KennethAshley/fez";
/** De-scope and drop a `fez-` prefix so @fezchat/git, git, and fez-git all match. */
export const norm = (n: string) => n.replace(/^@fezchat\//, "").replace(/^fez-/, "");
export const githubUrl = (name: string) =>
  catalogEntry(name)?.repo ?? `${REPO}/tree/main/packages/fez-${norm(name)}`;
export const npmUrl = (name: string) => `https://www.npmjs.com/package/${name}`;

export const catalogEntry = (name: string): CatalogEntry | undefined =>
  CATALOG.find((e) => norm(e.name) === norm(name));

/**
 * The shared install action: fetch + copy the parts (self-sufficient Rust
 * command), re-scan gui extensions so a panel appears live, and tell the
 * app to re-render. Used by the browse gallery AND @fez's in-chat offers.
 */
export async function installExtension(client: FezClient, name: string): Promise<void> {
  await invoke<string>("install_package", { name });
  await reloadGuiExtensions(client).catch(() => {});
  window.dispatchEvent(new CustomEvent("fez-extensions-changed"));
}
