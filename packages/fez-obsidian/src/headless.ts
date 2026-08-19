import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FezExtensionAPI } from "./api-types.js";

/**
 * fez-obsidian, headless part — works in any client, no GUI required.
 *
 * /obsidian          → export the current channel's doc to the vault
 * /obsidian <name>   → export under a custom note name
 * /obsidian vault <path> → set where the vault lives (persisted)
 *
 * Notes land in <vault>/fez/<name>.md. The vault path comes from
 * ~/.fez/obsidian.json, or the FEZ_OBSIDIAN_VAULT env var, defaulting
 * to ~/Obsidian.
 */

interface ClientLike {
  state: { scope?: { channelId: string } };
  channelRef(channelId: string): { name: string } | undefined;
  docVersions(channelId: string): Promise<{ content: string; created_at: number }[]>;
  messages?(channelId: string): readonly { authorName: string; content: string; ts: number }[];
}

const CONFIG_PATH = path.join(os.homedir(), ".fez", "obsidian.json");

function vaultPath(): string {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as { vault?: string };
    if (config.vault) return config.vault;
  } catch { /* fall through */ }
  return process.env.FEZ_OBSIDIAN_VAULT ?? path.join(os.homedir(), "Obsidian");
}

export default function obsidian(api: FezExtensionAPI): void {
  const client = api.client as ClientLike | undefined;
  if (!client) return;

  api.registerCommand("obsidian", async (args, ctx) => {
    const trimmed = args.trim();

    if (trimmed.startsWith("vault ")) {
      const vault = trimmed.slice(6).trim().replace(/^~(?=\/)/, os.homedir());
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ vault }, null, 2));
      ctx.reply(`🟣 vault set: ${vault}`);
      return;
    }

    const scope = client.state.scope;
    if (!scope) {
      ctx.reply("🟣 open a channel first — /obsidian exports its doc to your vault.");
      return;
    }
    const channelName = client.channelRef(scope.channelId)?.name ?? scope.channelId.slice(0, 8);
    const noteName = (trimmed || channelName).replace(/[^\w\s-]/g, "").trim() || channelName;

    const versions = await client.docVersions(scope.channelId);
    const doc = versions.at(-1);
    if (!doc) {
      ctx.reply(`🟣 #${channelName} has no doc yet (/doc set <text>) — nothing to export.`);
      return;
    }

    const vault = vaultPath();
    const dir = path.join(vault, "fez");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${noteName}.md`);
    const frontmatter = `---\nsource: fez #${channelName}\nexported: ${new Date(Date.now()).toISOString()}\n---\n\n`;
    fs.writeFileSync(file, frontmatter + doc.content + "\n");
    ctx.reply(`🟣 exported #${channelName} doc → ${file} (v${versions.length})`);
  });

  api.ui.setStatus("obsidian", "🟣");
}
