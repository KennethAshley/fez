import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every extension carries its own hand-written `api-types.ts` — a
 * structural mirror of FezExtensionAPI, type-only so the bundled file
 * has zero imports. That choice is deliberate and worth keeping: it is
 * why an extension can be two files and no dependency on fez.
 *
 * The cost is that nothing was checking the mirrors against the thing
 * they mirror. Each one says "structural typing keeps this honest", but
 * structural typing only checks a mirror against ITSELF — an extension
 * compiles happily against a copy that no longer describes reality, and
 * the first sign of trouble is a TypeError in someone else's process.
 *
 * Found by this test when it was written: fez-media and fez-moderation
 * both declared `nostr: NostrAccess` where the real API offers
 * `nostr?: NostrAccess`, and both called `api.nostr.*` with no guard.
 * Unreachable at the time (those calls sit in command handlers, and
 * commands only run in hosts where nostr exists) — which is exactly why
 * a type-level gate is the right place to catch it rather than a test
 * that has to guess at reachability.
 *
 * Mirrors are DISCOVERED, not listed. A new extension is covered the
 * day it lands, without anyone remembering to add it here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const REAL_API = path.join(REPO, "src/extensions.ts");
const WORK = path.join(REPO, "node_modules/.cache/fez-api-conformance");

/** `packages/<name>/src/api-types.ts` for every package that has one. */
function findMirrors(): { pkg: string; file: string }[] {
  const packagesDir = path.join(REPO, "packages");
  return fs
    .readdirSync(packagesDir)
    .map((pkg) => ({ pkg, file: path.join(packagesDir, pkg, "src/api-types.ts") }))
    .filter((m) => fs.existsSync(m.file))
    .sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/**
 * One probe per mirror: assign the REAL api to the MIRROR's type. If the
 * mirror declares a member the real API lacks, or narrows one it offers
 * (a required `nostr` where the real one is optional), this fails to
 * compile. The reverse direction is deliberately NOT checked — a mirror
 * is allowed to describe only the slice its extension uses, which is the
 * whole point of the pattern.
 */
function probeFor(mirrorFile: string, dir: string): string {
  const rel = (target: string) => {
    const r = path.relative(dir, target).replace(/\.ts$/, ".js");
    return r.startsWith(".") ? r : `./${r}`;
  };
  return [
    `import type { FezExtensionAPI as Real } from "${rel(REAL_API)}";`,
    `import type { FezExtensionAPI as Mirror } from "${rel(mirrorFile)}";`,
    `export const check: (real: Real) => Mirror = (real) => real;`,
    ``,
  ].join("\n");
}

describe("extension api mirrors", () => {
  it("every api-types.ts still describes the real FezExtensionAPI", () => {
    const mirrors = findMirrors();
    // If this ever finds nothing, the test is passing vacuously — that is
    // a failure of the test, not a clean bill of health.
    expect(mirrors.length).toBeGreaterThan(5);

    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });

    try {
      for (const { pkg, file } of mirrors) {
        fs.writeFileSync(path.join(WORK, `${pkg}.ts`), probeFor(file, WORK));
      }

      let output = "";
      try {
        execFileSync(
          path.join(REPO, "node_modules/.bin/tsc"),
          [
            "--noEmit",
            "--strict",
            "--target", "ES2022",
            "--module", "NodeNext",
            "--moduleResolution", "NodeNext",
            "--skipLibCheck",
            ...mirrors.map((m) => path.join(WORK, `${m.pkg}.ts`)),
          ],
          { cwd: REPO, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }

      if (output.trim().length === 0) return;

      // Turn tsc's output into something the reader can act on without
      // reverse-engineering which package a temp file belonged to.
      const offenders = new Set<string>();
      for (const line of output.split("\n")) {
        const hit = /([a-z0-9-]+)\.ts\(\d+,\d+\)/i.exec(line);
        if (hit) offenders.add(hit[1]);
      }
      const detail = output
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => `  ${l.replace(new RegExp(WORK + "/", "g"), "")}`)
        .join("\n");

      expect.fail(
        `${offenders.size} extension mirror(s) no longer match src/extensions.ts: ` +
          `${[...offenders].join(", ")}\n\n${detail}\n\n` +
          `Fix the MIRROR (packages/<name>/src/api-types.ts), not this test: copy the\n` +
          `member's declaration from src/extensions.ts, keeping optionality exactly as\n` +
          `it appears there. A mirror may omit anything its extension does not use, but\n` +
          `whatever it does declare has to match. If the real API is what changed, the\n` +
          `extension's own code likely needs a guard, not just a type edit.`
      );
    } finally {
      fs.rmSync(WORK, { recursive: true, force: true });
    }
  }, 120_000);
});
