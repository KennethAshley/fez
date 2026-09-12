import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { normalizeWorkspaceRelay, resolveWorkspaceOwner } from "../../packages/fez-client/dist/workspace-owner.js";
import { fezHome } from "./fez-home.js";

/** First use records the owner; later metadata cannot replace it. An expected
 * key comes from a trusted invite/configuration, never the agent's owner. */
export function pinWorkspaceOwner(
  relay: string, advertised?: string, expected?: string,
  directory = fezHome("workspace-owners"),
): string | undefined {
  expected = resolveWorkspaceOwner(process.env.FEZ_WORKSPACE_OWNER, undefined, expected);
  const id = createHash("sha256").update(normalizeWorkspaceRelay(relay)).digest("hex");
  const file = path.join(directory, `${id}.pubkey`);
  const read = (): string | undefined => {
    try { return fs.readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  };
  const pinned = read();
  const owner = resolveWorkspaceOwner(pinned, advertised, expected);
  if (!owner || pinned !== undefined) return owner;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Publish complete bytes without overwriting a pin another process won.
    try { fs.linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const dir = fs.openSync(directory, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return resolveWorkspaceOwner(read(), advertised, expected ?? owner);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
