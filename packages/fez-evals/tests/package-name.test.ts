import { describe, it, expect } from "vitest";
import { npmPackageName } from "../../../src/extensions/package-manager.js";

/**
 * The install-path contract. Three sites (registry name, npm install dir,
 * content dir) each derived a package's name their own way; for scoped
 * packages they disagreed — installNpm wrote to npm/loom while
 * getContentDir read npm/fezchat/loom — so readManifest returned null and
 * EVERY install hook (extension entry, parts, personas) silently skipped.
 * `fez install @fezchat/loom` printed ✅ and installed nothing.
 */
describe("npmPackageName — one name per package, path-safe", () => {
  it("strips the store scope", () => {
    expect(npmPackageName("npm:@fezchat/loom")).toBe("loom");
  });

  it("prefixes foreign scopes so @acme/x can't collide with @fezchat/x", () => {
    expect(npmPackageName("npm:@acme/thing")).toBe("acme-thing");
  });

  it("passes unscoped names through", () => {
    expect(npmPackageName("npm:lodash")).toBe("lodash");
  });

  it("accepts a bare package name without the npm: prefix", () => {
    expect(npmPackageName("@fezchat/kanban")).toBe("kanban");
  });

  it("never returns a name with a path separator", () => {
    for (const s of ["npm:@fezchat/loom", "npm:@acme/thing", "npm:plain"]) {
      expect(npmPackageName(s)).not.toContain("/");
    }
  });
});
