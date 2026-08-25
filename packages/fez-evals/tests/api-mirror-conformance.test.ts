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
const REAL_API = path.join(REPO, "src/extensions/extensions.ts");
const REAL_GUI_API = path.join(REPO, "packages/fez-desktop/src/gui-extensions.ts");
const WORK = path.join(REPO, "node_modules/.cache/fez-api-conformance");

/**
 * The two mirror families, and what each one claims to describe.
 *
 * `gui-types.ts` was uncovered until a second one existed: fez-github
 * had the only copy, so a drifting mirror was a one-package problem
 * nobody would notice. A GUI mirror fails LOUDER than a headless one —
 * the panel is loaded from a blob URL at boot with no build step
 * between it and the user, so a member that no longer exists is a
 * blank card in settings rather than a compile error.
 */
const FAMILIES = [
  {
    file: "src/api-types.ts",
    real: REAL_API,
    name: "FezExtensionAPI",
    // The CLI is NodeNext, and its own imports carry .js extensions.
    resolution: ["--module", "NodeNext", "--moduleResolution", "NodeNext"],
  },
  {
    file: "src/gui-types.ts",
    real: REAL_GUI_API,
    name: "GuiExtensionApi",
    mirrorName: "GuiExtensionAPI",
    // The desktop is Vite, so its relative imports are extensionless.
    // Compiling it under NodeNext fails on the real API's own source
    // before it ever reaches the mirror — a green test that proved
    // nothing about the mirror. Each family compiles the way its own
    // package does.
    // --jsx too: the real API imports a .tsx module for artifact viewers.
    resolution: ["--module", "ESNext", "--moduleResolution", "bundler", "--jsx", "react-jsx"],
  },
];

interface Mirror {
  pkg: string;
  file: string;
  real: string;
  name: string;
  mirrorName: string;
  resolution: string[];
}

/** Every mirror in the tree, of either family. */
function findMirrors(): Mirror[] {
  const packagesDir = path.join(REPO, "packages");
  const found: Mirror[] = [];
  for (const pkg of fs.readdirSync(packagesDir)) {
    for (const family of FAMILIES) {
      const file = path.join(packagesDir, pkg, family.file);
      if (!fs.existsSync(file)) continue;
      found.push({
        // The probe filename has to be unique per mirror, not per
        // package — fez-git has both families.
        pkg: family.file.includes("gui-") ? `${pkg}--gui` : pkg,
        file,
        real: family.real,
        name: family.name,
        mirrorName: family.mirrorName ?? family.name,
        resolution: family.resolution,
      });
    }
  }
  return found.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/**
 * One probe per mirror: assign the REAL api to the MIRROR's type. If the
 * mirror declares a member the real API lacks, or narrows one it offers
 * (a required `nostr` where the real one is optional), this fails to
 * compile. The reverse direction is deliberately NOT checked — a mirror
 * is allowed to describe only the slice its extension uses, which is the
 * whole point of the pattern.
 */
function probeFor(mirror: Mirror, dir: string): string {
  const rel = (target: string) => {
    const r = path.relative(dir, target).replace(/\.ts$/, ".js");
    return r.startsWith(".") ? r : `./${r}`;
  };
  return [
    `import type { ${mirror.name} as Real } from "${rel(mirror.real)}";`,
    `import type { ${mirror.mirrorName} as Mirror } from "${rel(mirror.file)}";`,
    `export const check: (real: Real) => Mirror = (real) => real;`,
    ``,
  ].join("\n");
}

describe("extension api mirrors", () => {
  it("every api-types.ts and gui-types.ts still describes the real API", () => {
    const mirrors = findMirrors();
    // If this ever finds nothing, the test is passing vacuously — that is
    // a failure of the test, not a clean bill of health.
    expect(mirrors.length).toBeGreaterThan(5);

    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });

    try {
      for (const mirror of mirrors) {
        fs.writeFileSync(path.join(WORK, `${mirror.pkg}.ts`), probeFor(mirror, WORK));
      }

      let output = "";
      // One tsc per family: the two real APIs live in packages compiled
      // under different module resolutions, and forcing one on both
      // fails on the API's own imports instead of on the mirror.
      for (const family of FAMILIES) {
        const batch = mirrors.filter((m) => m.resolution === family.resolution);
        if (batch.length === 0) continue;
        try {
          execFileSync(
            path.join(REPO, "node_modules/.bin/tsc"),
            [
              "--noEmit",
              "--strict",
              "--target", "ES2022",
              ...family.resolution,
              "--skipLibCheck",
              ...batch.map((m) => path.join(WORK, `${m.pkg}.ts`)),
            ],
            { cwd: REPO, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
          );
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string };
          output += `${e.stdout ?? ""}${e.stderr ?? ""}`;
        }
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
        `${offenders.size} extension mirror(s) no longer match the real API: ` +
          `${[...offenders].join(", ")}\n\n${detail}\n\n` +
          `Fix the MIRROR (packages/<name>/src/api-types.ts, or gui-types.ts for a\n` +
          `"--gui" offender), not this test: copy the member's declaration from\n` +
          `src/extensions.ts or fez-desktop's gui-extensions.ts, keeping optionality exactly as\n` +
          `it appears there. A mirror may omit anything its extension does not use, but\n` +
          `whatever it does declare has to match. If the real API is what changed, the\n` +
          `extension's own code likely needs a guard, not just a type edit.`
      );
    } finally {
      fs.rmSync(WORK, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * @fezchat/extension-api — the PUBLISHED contract, held to the real hosts.
 *
 * The mirror families above keep each extension's private copy honest.
 * This keeps the PUBLIC package honest: a third party builds against
 * @fezchat/extension-api, so if it ever promises a member a real host does
 * not provide, that stranger's extension breaks at runtime with nothing
 * to warn them. So we assign each REAL host API to the package's type —
 * same direction as a mirror probe: the package may describe only a
 * slice, never more than the host offers.
 */
describe("@fezchat/extension-api is a faithful subset of the real hosts", () => {
  const PKG = path.join(REPO, "packages/fez-extension-api/src");
  const SURFACES = [
    { name: "FezExtensionAPI", real: REAL_API, pkgFile: "headless.ts", resolution: ["--module", "NodeNext", "--moduleResolution", "NodeNext"] },
    { name: "RelayExtensionAPI", real: path.join(REPO, "packages/fez-relay/src/extensions.ts"), pkgFile: "relay.ts", resolution: ["--module", "NodeNext", "--moduleResolution", "NodeNext"] },
    { name: "WorkspaceRequest", real: path.join(REPO, "packages/fez-acp/src/workspaces.ts"), pkgFile: "workspace.ts", resolution: ["--module", "NodeNext", "--moduleResolution", "NodeNext"] },
    { name: "GuiExtensionApi", real: REAL_GUI_API, pkgFile: "gui.ts", resolution: ["--module", "ESNext", "--moduleResolution", "bundler", "--jsx", "react-jsx"] },
  ];

  it("every published surface accepts its real host API", () => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    const rel = (dir: string, target: string) => {
      const r = path.relative(dir, target).replace(/\.ts$/, ".js");
      return r.startsWith(".") ? r : `./${r}`;
    };
    let output = "";
    try {
      for (const s of SURFACES) {
        const probe = path.join(WORK, `pkg-${s.pkgFile}.ts`);
        fs.writeFileSync(
          probe,
          [
            `import type { ${s.name} as Real } from "${rel(WORK, s.real)}";`,
            `import type { ${s.name} as Pub } from "${rel(WORK, path.join(PKG, s.pkgFile))}";`,
            `export const check: (real: Real) => Pub = (real) => real;`,
            ``,
          ].join("\n")
        );
        try {
          execFileSync(
            path.join(REPO, "node_modules/.bin/tsc"),
            ["--noEmit", "--strict", "--target", "ES2022", ...s.resolution, "--skipLibCheck", probe],
            { cwd: REPO, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
          );
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string };
          output += `\n[${s.name}]\n${e.stdout ?? ""}${e.stderr ?? ""}`;
        }
      }
      if (output.trim()) {
        expect.fail(
          `@fezchat/extension-api no longer matches the real host(s):\n${output}\n\n` +
            `Fix packages/fez-extension-api/src/<surface>.ts to describe only what the host offers — ` +
            `the published contract must never promise a member a host lacks.`
        );
      }
    } finally {
      fs.rmSync(WORK, { recursive: true, force: true });
    }
  }, 120_000);
});
