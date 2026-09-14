import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { useConfig } from "./config-store";
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
  { name: "@fezchat/kanban", title: "Kanban", blurb: "Boards on your docs — agents move their cards and review work on a daily schedule.", where: "Use the ▦ board toggle in a doc. Named board pages include daily review, pause and schedule controls.", permissions: ["ui", "read:channels", "read:agents", "publish", "sign", "background"] },
  { name: "@fezchat/polls", title: "Polls", blurb: "Vote by reaction, tally in real time.", where: "Adds /poll to the composer; poll cards render under the message.", permissions: ["ui", "commands", "read:channels", "publish"] },
  { name: "@fezchat/github", title: "GitHub", blurb: "A window onto a GitHub repo — a pull request becomes a thread you can talk in.", where: "Adds /github and a GitHub settings panel.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
  { name: "@fezchat/sentry", title: "Sentry responder", blurb: "Bring new incidents into a channel and assign an agent to investigate, test, and prepare a draft fix.", where: "Configure one Sentry project, repository, channel, and agent in extension settings. Uses a Sentry read token; automatic investigation is opt-in and uses agent turns.", permissions: ["ui", "read:channels", "read:agents", "sign", "publish", "background", "network:sentry.io", "network:us.sentry.io", "network:de.sentry.io"] },
  { name: "@fezchat/slack", title: "Slack", blurb: "Mention Fez in Slack to start agent work and receive the result in the same thread.", where: "Connect a custom Slack app in extension settings, then choose an allowed channel, users, and agent. Runs through the sentinel while this machine is awake.", permissions: ["ui", "read:channels", "read:agents", "sign", "publish", "background", "network:slack.com", "network:.slack.com"] },
  { name: "@fezchat/obsidian", title: "Obsidian", blurb: "Export a channel's docs to your Obsidian vault.", where: "Adds /obsidian to the composer.", permissions: ["ui", "commands", "read:channels"] },
  { name: "@fezchat/live-blocks", title: "Live Blocks", blurb: "A markdown block an agent keeps breathing — live data that updates itself inside a doc.", where: "Renders live blocks inside docs.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
  { name: "@fezchat/themes", title: "Themes", blurb: "The classics — Dracula, Nord, Catppuccin, Solarized, Tokyo Night, Monokai, Night Owl, Kanagawa, Flexoki, and ten more. Each a light/dark pair.", where: "Adds a shelf of packs to Settings → theme.", permissions: ["ui"] },
  { name: "@fezchat/wallet", title: "Wallet", blurb: "Per-agent allowance wallets — HD-derived accounts from one master mnemonic, TAO live, threshold consent via owner-signed reactions. The balance IS the cap.", where: "Adds a wallet panel and the payment skill agents spend through.", permissions: ["network:.opentensor.ai", "network:.base.org", "network:relay", "publish", "read:channels", "ui", "processes"] },
  { name: "@fezchat/mining", title: "Mining", blurb: "Manage subnet miners and uploaded agents from one fleet, with configuration, history and agent tools.", where: "Adds the Mining panel and mining tools. Install Wallet and a subnet adapter to get started.", permissions: ["ui", "processes", "personas", "background", "read:channels", "publish", "network:.opentensor.ai"] },
  { name: "@fezchat/numinous", title: "Numinous", blurb: "Submit forecasting agents to Numinous SIGNAL on testnet 155. Validators host the code; Fez tracks versions and activation.", where: "Adds Numinous to Mining. Requires Mining and Wallet 0.1.14+. Docker is needed for local code checks. Testnet only; uploads require explicit confirmation.", permissions: ["network:stg.numinous.earth", "processes"] },
  { name: "@fezchat/oro", title: "ORO", blurb: "Unsupported for testnet mining. ORO targets mainnet subnet 15.", where: "No public ORO testnet mining service has been verified. Local development does not mine or earn rewards. Keep Wallet on testnet; this adapter is not a supported testnet mining option.", permissions: ["network:api.oroagents.com", "processes"] },
  { name: "@fezchat/ridges", title: "Ridges", blurb: "Pay for GitHub fixes or submit your coding agent to SN62. Track jobs, PRs and receipts in chat.", where: "Adds Ridges agent tools and SN62 in Mining. Ask your agent for job history or to configure channel updates.", permissions: ["network:product.ridges.ai", "network:agent-upload.ridges.ai", "network:api.github.com", "processes", "read:channels", "publish", "commands", "background"] },
  { name: "@fezchat/memory", title: "Memory", blurb: "Shared team memory for agents — fez_remember / fez_recall over append-only, signed events on the relay. Shared by default, because the relay is.", where: "Adds the fez_remember and fez_recall skills to granted agents.", permissions: ["read:channels", "publish"] },
  { name: "@fezchat/ditto", title: "Ditto Memory", blurb: "Let selected agents search your Ditto memories, retrieve their sources, and save notes you explicitly request.", where: "Add DITTO_API_KEY in Settings → secrets → ditto, then attach ditto in an agent's tool picker. Agents get access to the connected Ditto account; Fez team memory stays separate.", permissions: ["network:api.heyditto.ai"] },
  { name: "@fezchat/loom", title: "Loom", blurb: "Save, reopen, and share artifacts from any agent. Includes @loom as an optional builder.", where: "Adds the ▣ artifacts library. Saves stay with your account and workspace on this device.", permissions: ["read:channels", "publish", "personas", "ui"] },
  { name: "@fezchat/bazaar", title: "Bazaar", blurb: "The fez bazaar — run a miner that serves the subnet, watch how it's doing, and ask the market questions with bazaar_ask.", where: "Adds a Bazaar panel, the bazaar_ask skill, and the fez-bazaar-miner program.", permissions: ["network:.fez.chat", "read:channels", "read:agents", "ui", "processes", "notifications"], repo: "https://github.com/KennethAshley/fez-bazaar" },
  { name: "@fezchat/web", title: "Web", blurb: "Eyes for your agents — search the public web (no API key; rides fez's hosted search) and read pages as clean text, with private-network addresses refused by construction.", where: "Adds web_search and web_fetch skills any attached agent can use. Plainly: agents you attach this to can reach any public website. For a full driven browser, attach browser=npm:@playwright/mcp alongside it.", permissions: ["network:*"] },
  { name: "@fezchat/browser", title: "Browser", blurb: "Open websites beside your chat, with separate browser panes for parallel work.", where: "Open /browser in chat. Add Browser Use to agents for visible mouse and keyboard control. Settings also provides a separate Camofox setup for anonymous reading tools.", permissions: ["network:*", "ui", "processes", "commands"] },
  { name: "@fezchat/browser-use", title: "Browser Use", blurb: "Let agents click, type, and scroll in your Fez browser panes.", where: "Attach to a local agent and restart it, then open /browser. Each pane has one driver and a waiting queue. Take control pauses its agents immediately. Requires the native-browser desktop build.", permissions: ["network:127.0.0.1"] },
  { name: "@fezchat/elevenlabs", title: "ElevenLabs", blurb: "Agents speak — ask any granted agent to say something and a voice note lands in the channel, in that agent's own stable voice.", where: "Adds the fez_speak skill; voice map in Settings → extensions.", permissions: ["network:api.elevenlabs.io", "network:relay", "publish", "read:channels", "ui"] },
  { name: "@fezchat/desearch", title: "Desearch", blurb: "Eyes on X — search X/Twitter in real time through Desearch (Bittensor subnet 22), the one thing Web's free commons can't do. Every call reports its own cost.", where: "Adds the desearch_x skill any attached agent can use. Paid per call from your Desearch balance (key from console.desearch.ai).", permissions: ["network:api.desearch.ai"] },
  { name: "@fezchat/lium", title: "Lium", blurb: "Bodies for agents — rent GPU machines by the hour on Lium (Bittensor subnet 51), run jobs, ship results, give the machine back. Every rent carries a TTL the marketplace itself enforces; your prepaid balance is the cap.", where: "Adds the lium skills any attached agent can use. Plainly: agents you attach this to can run commands on rented machines and pay for them from your Lium balance — gated by a price ceiling, a mandatory TTL, and a balance check before any spend.", permissions: ["network:*"] },
  { name: "@fezchat/targon", title: "Targon", blurb: "Bodies for agents, Targon edition — rent GPU machines by the hour on Targon (Bittensor subnet 4) over its REST API. No marketplace TTL exists here: a workload bills until it's deleted, so the guards and the ledger carry the spend story.", where: "Adds the targon skills any attached agent can use. Plainly: agents you attach this to can rent machines, run commands on them, and pay from your prepaid Targon credits — gated by a price ceiling and a balance check before any spend, and told loudly that billing only stops at targon_rm.", permissions: ["network:api.targon.com"] },
];

/**
 * Connectable services (Connections — sign in, don't paste). Not npm
 * packages: "installing" one is a browser sign-in the bundled fez-agent
 * runs (connect_service), which lands tokens in the keychain and
 * registers the skill in settings.json. Shown on the gallery shelf AND
 * as unlockable rows in the agent editor's tool picker — a shelf you
 * can't see is a shelf that doesn't exist.
 */
/** Broad buckets so a growing list stays scannable — the connections view
 * groups by these, and CONNECTION_CATEGORIES fixes their order. */
export type ConnCategory = "Dev" | "Projects" | "Data" | "Payments" | "Design & Docs" | "Support";
export const CONNECTION_CATEGORIES: ConnCategory[] = ["Dev", "Projects", "Data", "Payments", "Design & Docs", "Support"];

export interface ConnectableEntry {
  /** The mcpServers key personas declare — and the keychain identity. */
  key: string;
  title: string;
  category: ConnCategory;
  blurb: string;
}
export const CONNECTABLE: ConnectableEntry[] = [
  { key: "linear", title: "Linear", category: "Dev", blurb: "Your agent reads and writes issues, projects, and comments. Sign in with your Linear account — no API key." },
  { key: "github", title: "GitHub", category: "Dev", blurb: "Repos, PRs, issues. Sign-in coming; today, paste a PAT in Settings → secrets and it works the same." },
  { key: "sentry", title: "Sentry", category: "Dev", blurb: "Errors, issues, and releases across your projects. Sign in — no API key." },
  { key: "vercel", title: "Vercel", category: "Dev", blurb: "Deployments, projects, and logs. Sign in with your Vercel account — no API key." },
  { key: "cloudflare", title: "Cloudflare", category: "Dev", blurb: "Workers, DNS, and account resources. Sign in with your Cloudflare account — no API key." },
  { key: "neon", title: "Neon", category: "Data", blurb: "Postgres databases and branches. Sign in — no API key." },
  { key: "supabase", title: "Supabase", category: "Data", blurb: "Database, auth, and storage. Sign in with your Supabase account — no API key." },
  { key: "stripe", title: "Stripe", category: "Payments", blurb: "Customers, payments, and billing. Sign in — no API key." },
  { key: "paypal", title: "PayPal", category: "Payments", blurb: "Invoices, orders, and transactions. Sign in — no API key." },
  { key: "notion", title: "Notion", category: "Design & Docs", blurb: "Your agent works in the pages and databases you grant at sign-in — no API key." },
  { key: "canva", title: "Canva", category: "Design & Docs", blurb: "Designs and brand assets. Sign in — no API key." },
  { key: "webflow", title: "Webflow", category: "Design & Docs", blurb: "Sites and CMS collections. Sign in — no API key." },
  { key: "google-drive", title: "Google Drive", category: "Design & Docs", blurb: "Files you pick and files your agents create — drive.file, never the whole drive. Sign in with Google." },
  { key: "google-docs", title: "Google Docs", category: "Design & Docs", blurb: "Documents, read and write. Sign in with Google." },
  { key: "google-sheets", title: "Google Sheets", category: "Data", blurb: "Spreadsheets, read and write. Sign in with Google." },
  { key: "google-calendar", title: "Google Calendar", category: "Design & Docs", blurb: "Events and calendars, read and write. Sign in with Google." },
  { key: "atlassian", title: "Atlassian", category: "Dev", blurb: "Jira issues and Confluence pages — one sign-in covers both. No API key." },
  { key: "buildkite", title: "Buildkite", category: "Dev", blurb: "Pipelines, builds, and logs. Sign in — no API key." },
  { key: "asana", title: "Asana", category: "Projects", blurb: "Tasks, projects, and goals. Sign in — no API key." },
  { key: "monday", title: "Monday", category: "Projects", blurb: "Boards, items, and updates. Sign in — no API key." },
  { key: "todoist", title: "Todoist", category: "Projects", blurb: "Tasks and projects, read and write. Sign in — no API key." },
  { key: "figma", title: "Figma", category: "Design & Docs", blurb: "Files, components, and dev-mode context. Sign-in coming." },
  { key: "intercom", title: "Intercom", category: "Support", blurb: "Conversations, contacts, and help articles. Sign in — no API key." },
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

export const SENSITIVE = new Set(["publish", "personas", "background", "processes", "network:*"]);

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
/** Package records include tool-only extensions; legacy linked parts may have no version. */
export function useInstalledExtensions(): Set<string> {
  const { versions, localParts } = useConfig();
  return useMemo(() => new Set([...Object.keys(versions), ...Object.keys(localParts)].map(norm)), [versions, localParts]);
}
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
