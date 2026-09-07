import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SubnetMiner } from "@fezchat/extension-api";
import { fezHome } from "./state.js";

export async function loadDescriptors(home = fezHome()): Promise<SubnetMiner[]> {
  const dir = path.join(home, "miners");
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith(".js")); } catch { return []; }
  const out: SubnetMiner[] = [];
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      const list = mod.default;
      if (Array.isArray(list)) out.push(...list);
    } catch (e) {
      console.warn(`fez-mine: skipping ${f}: ${(e as Error).message}`);
    }
  }
  return out;
}
