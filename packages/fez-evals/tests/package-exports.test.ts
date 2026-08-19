import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as protocol from "@fez/protocol";

/**
 * Every name a package imports from @fez/protocol must actually be
 * exported by it.
 *
 * This exists because of a specific escape: `resolveRelays` was added to
 * settings.ts and imported by two extension MCP servers, but never added
 * to the package's public exports. Both servers bundle with
 * `--packages=external`, so esbuild never resolved the import and the
 * build passed. tsc in those packages would have caught it — but their
 * `check` script isn't part of the root build, so nothing ran it.
 *
 * The result was two agent tools that were dead on arrival, failing at
 * import time with a SyntaxError, in a commit whose tests all passed.
 * A missing export is a link error; nothing about the shape of this repo
 * makes one visible, so it gets its own gate.
 */

const ROOT = new URL("../../../", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * VALUE imports from @fez/protocol, per file.
 *
 * Types are skipped — both `import type { X }` and inline `type X`
 * specifiers erase before anything runs, so a missing type is a compile
 * error tsc already reports and never a link error at runtime. Only
 * names that survive into the emitted import are worth checking here.
 */
function protocolImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const names: string[] = [];
  for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@fez\/protocol["']/g)) {
    if (match[1]) continue; // `import type { … }` — nothing survives
    for (const raw of match[2].split(",")) {
      const specifier = raw.trim();
      if (!specifier || /^type\s/.test(specifier)) continue;
      const name = specifier.split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("@fez/protocol public surface", () => {
  const packages = readdirSync(join(ROOT, "packages")).filter((name) => {
    try {
      return statSync(join(ROOT, "packages", name, "src")).isDirectory();
    } catch {
      return false;
    }
  });

  it("finds packages to check (so a broken glob can't pass vacuously)", () => {
    expect(packages.length).toBeGreaterThan(5);
  });

  for (const pkg of packages) {
    it(`${pkg} imports only names @fez/protocol actually exports`, () => {
      const missing: string[] = [];
      for (const file of sourceFiles(join(ROOT, "packages", pkg, "src"))) {
        for (const name of protocolImports(file)) {
          // Type-only exports vanish at runtime, so only flag names that
          // are absent AND look like values (lowercase or PascalCase fn).
          if (!(name in protocol)) missing.push(`${name} (${file.replace(ROOT, "")})`);
        }
      }
      expect(missing, `not exported by @fez/protocol:\n  ${missing.join("\n  ")}`).toEqual([]);
    });
  }
});
