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
}

export const CATALOG: CatalogEntry[] = [
  { name: "@fezchat/git", title: "Git", blurb: "Host repositories on the relay — a repo is a channel, agents push as themselves, and merge is a button.", where: "Adds a Repos panel in Settings, and a board on repo threads.", permissions: ["ui", "commands", "read:channels", "publish", "background", "personas", "network:relay"] },
  { name: "@fezchat/kanban", title: "Kanban", blurb: "Boards on your docs — columns are headings, cards are checkboxes; agents move their own cards.", where: "Opens on any doc that's a board — use the ▦ board toggle in a doc.", permissions: ["ui", "read:channels", "publish"] },
  { name: "@fezchat/polls", title: "Polls", blurb: "Vote by reaction, tally in real time.", where: "Adds /poll to the composer; poll cards render under the message.", permissions: ["ui", "commands", "read:channels", "publish"] },
  { name: "@fezchat/github", title: "GitHub", blurb: "A window onto a GitHub repo — a pull request becomes a thread you can talk in.", where: "Adds /github and a GitHub settings panel.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
  { name: "@fezchat/obsidian", title: "Obsidian", blurb: "Export a channel's docs to your Obsidian vault.", where: "Adds /obsidian to the composer.", permissions: ["ui", "commands", "read:channels"] },
  { name: "@fezchat/live-blocks", title: "Live Blocks", blurb: "A markdown block an agent keeps breathing — live data that updates itself inside a doc.", where: "Renders live blocks inside docs.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
  { name: "@fezchat/themes", title: "Themes", blurb: "The classics — Dracula, Nord, Catppuccin, Solarized, Tokyo Night, Monokai, Night Owl, Kanagawa, Flexoki, and ten more. Each a light/dark pair.", where: "Adds a shelf of packs to Settings → theme.", permissions: ["ui"] },
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
  "network:relay": "talk to your relay",
};

export const SENSITIVE = new Set(["publish", "personas", "background", "processes"]);

const REPO = "https://github.com/KennethAshley/fez";
/** De-scope and drop a `fez-` prefix so @fezchat/git, git, and fez-git all match. */
export const norm = (n: string) => n.replace(/^@fezchat\//, "").replace(/^fez-/, "");
export const githubUrl = (name: string) => `${REPO}/tree/main/packages/fez-${norm(name)}`;
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
