import { fezHome } from "../shared/fez-home.js";
import fs from "fs/promises";
import path from "path";

/**
 * Extension state — the seam that ends every extension inventing its own
 * file under ~/.fez.
 *
 * One JSON file per extension in ~/.fez/extension-data/, keyed by the
 * extension's install name, so `fez remove` can drop the namespace and
 * nothing else has to know the layout. Deliberately not a permission:
 * the permission list is consent to things done TO the user (publish as
 * you, read your DMs), and "keep its own notes" isn't one — a headless
 * extension could fs.writeFile anywhere regardless, and a gate here
 * would imply a sandbox that doesn't exist (see extension-permissions.ts).
 *
 * Values are JSON — whatever survives JSON.parse(JSON.stringify(v)).
 * Writes are serialized per instance; the process holds one instance per
 * extension, so last-write-wins races only exist across processes, same
 * as settings.json.
 */
export interface StorageAccess {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function makeStorage(name: string, dataDir: string = fezHome("extension-data")): StorageAccess {
  const file = path.join(dataDir, `${name}.json`);
  // One op at a time: each read-modify-write chains behind the previous,
  // so Promise.all'd sets can't read the same snapshot and drop keys.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const next = chain.then(op, op);
    chain = next.catch(() => {});
    return next;
  };

  const load = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await fs.readFile(file, "utf-8"));
    } catch {
      // Missing or corrupt reads as empty — an extension must come up
      // even if its state file was truncated mid-write or hand-mangled.
      return {};
    }
  };
  const save = async (data: Record<string, unknown>): Promise<void> => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
  };

  return {
    get: (key) => enqueue(async () => (await load())[key] as never),
    set: (key, value) =>
      enqueue(async () => {
        const data = await load();
        data[key] = value;
        await save(data);
      }),
    delete: (key) =>
      enqueue(async () => {
        const data = await load();
        if (!(key in data)) return;
        delete data[key];
        await save(data);
      }),
    keys: () => enqueue(async () => Object.keys(await load())),
  };
}

/** `fez remove <name>` calls this — the namespace dies with the package. */
export async function removeStorage(name: string, dataDir: string = fezHome("extension-data")): Promise<void> {
  await fs.rm(path.join(dataDir, `${name}.json`), { force: true });
}
