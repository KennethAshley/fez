# GUI Extension Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop GUI loads extensions by reading `~/.fez/packages/*/` and each manifest's `gui` part (VS Code flow, no `gui-extensions/` symlink), and renders them via the mount model — the host hands each view a DOM node and the extension mounts into it — with a compatibility bridge so today's element-returning extensions keep working untouched.

**Architecture:** This is Plan 1 of the GUI extension DX spec — the runtime (loading + rendering). Plan 2 (Tailwind preset, `@fezchat/ui`, `fez create`) builds on it. The loader change is internal to `list_gui_extensions` (its `(name, code)` return contract is preserved, so the frontend loader is unchanged). The mount change widens the UI-returning registration callbacks from `() => El` to `(host?: HTMLElement) => El | Dispose | void`: a callback that returns an element is legacy (host renders it, as today); one that takes the host node and returns a function mounts its own root and returns a disposer. A new `MountPoint` host component runs the callback and handles either return.

**Tech Stack:** Rust (Tauri, cargo tests), TypeScript (React 19 desktop via Vite; `@fezchat/extension-api` types; CLI `PackageManager`, vitest via fez-evals). No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-08-28-gui-extension-dx-design.md` (§1, §2, §3 — loading, separation, mount model. §4/§7 styling and the UI kit are Plan 2).

## Global Constraints

- Loader source of truth: `~/.fez/packages/<base>/`, read via each `package.json`'s `fez.parts.gui` (a manifest-relative path); the gui bundle is read from `packages/<base>/<gui-rel>`. `<base>` is the de-scoped basename (already the convention from extension-packages).
- `list_gui_extensions` keeps its `Vec<(String, String)>` = `(name, code)` return contract — the frontend loader must not need to change.
- `bin/` symlinks and the non-GUI surface index (`extensions/`, `relay-extensions/`, `workspace-providers/`) are NOT touched — GUI surface only.
- The mount-bridge callback signature is exactly `(host?: HTMLElement) => El | Dispose | void` where `Dispose = () => void`. Return classification: a function → disposer (mount form); a React element → legacy (host renders it into the node); `undefined`/void → nothing to render, nothing to dispose.
- No broken window: the loader change, the symlink-stop-on-install, and the migration removal ship together; element-returning extensions keep rendering throughout.
- Ownership rule (reused from extension-packages): a flat entry is owned by `<name>` iff it is a symlink whose canonicalized target resolves under the canonicalized `packages/<name>/`.
- Tests: fez-evals with `bunx vitest run <file>` (ignore stale `.worktrees/` copies); Rust with `cargo test` in `packages/fez-desktop/src-tauri` (zero warnings, `cargo build` too). Commits lowercase/why-focused, NO Co-Authored-By/Claude-Session trailers.

---

### Task 1: GUI loader reads `packages/*/` and the manifest gui part

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (`list_gui_extensions` ~line 417)
- Modify: `packages/fez-desktop/src-tauri/src/package_install.rs` (add a tested helper if cleaner)
- Test: cargo tests in `package_install.rs` (has the `fixture_tar` + tempdir pattern) or an inline `#[cfg(test)]` in lib.rs

**Interfaces:**
- Produces: `list_gui_extensions` returns the same `Vec<(String, String)>` `(name, code)`, now sourced by scanning `packages/*/` and reading each manifest's `fez.parts.gui`.
- Consumes: `installed_manifest(base, home)` from `package_install.rs` (reads `packages/<base>/package.json`).

- [ ] **Step 1: Write the failing cargo test.** Reuse the `install_from_tarball` fixture to lay down a package dir, then assert the loader finds its gui part by manifest, not by the symlink dir:

```rust
#[test]
fn gui_loader_reads_the_manifest_gui_part_from_the_package_dir() {
    let home = tempfile::tempdir().unwrap();
    // fixture_tar already declares fez.parts.gui = "dist/gui.js"
    install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
    let found = gui_parts(home.path());               // the new pure scanner
    assert!(found.iter().any(|(name, code)| name == "tidy" && code.contains("export default")));
    // it is read from the package dir, and does NOT depend on gui-extensions/
    std::fs::remove_dir_all(home.path().join("gui-extensions")).ok();
    assert!(gui_parts(home.path()).iter().any(|(n, _)| n == "tidy"), "must not depend on the symlink dir");
}
```

(Adjust `fixture_tar`'s `dist/gui.js` content so the assertion substring exists.)

- [ ] **Step 2: Run — verify it fails** (`gui_parts` missing / still reads the symlink dir). `cargo test gui_loader`.
- [ ] **Step 3: Implement.** Add `pub(crate) fn gui_parts(home: &Path) -> Vec<(String, String)>`: read `home/packages`, for each subdir read `package.json`, and if `fez.parts.gui` is a string, read `packages/<name>/<gui-rel>` and push `(dir_name, code)`; skip a dir with no gui part or an unreadable bundle. Rewrite `list_gui_extensions` to `Ok(gui_parts(&home_path))`. Delete the `gui-extensions` dir read.
- [ ] **Step 4: `cargo test` green, `cargo build` zero warnings.**
- [ ] **Step 5: Commit** — "gui loader reads the package dir, not the symlink index".

### Task 2: Install stops creating the `gui-extensions` symlink (both installers)

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/package_install.rs` (`install_from_tarball` parts loop)
- Modify: `src/extensions/package-manager.ts` (`installParts`)
- Test: `packages/fez-evals/tests/package-lifecycle.test.ts`; cargo test in `package_install.rs`

**Interfaces:**
- Produces: after install, `packages/<base>/dist/gui.js` exists but `gui-extensions/<base>.js` does NOT. All other symlinks (headless/relay/workspace/bin) unchanged.
- Consumes: Task 1's loader (so the gui part is still found without the symlink).

- [ ] **Step 1: Failing tests.** vitest (extend the existing tidy install test):

```ts
test("install no longer creates the gui-extensions symlink (the loader reads packages/*/)", () => {
  expect(fs.existsSync(at("gui-extensions", "tidy.js"))).toBe(false);
  // the other surface symlinks and the package dir gui part remain
  expect(fs.existsSync(at("extensions", "tidy.js"))).toBe(true);
  expect(fs.existsSync(at("packages", "tidy", "dist", "gui.js"))).toBe(true);
});
```

cargo (in `package_install.rs`):

```rust
#[test]
fn install_creates_no_gui_extensions_symlink() {
    let home = tempfile::tempdir().unwrap();
    install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
    assert!(!home.path().join("gui-extensions").join("tidy.js").exists());
    assert!(home.path().join("packages").join("tidy").join("dist").join("gui.js").exists());
}
```

- [ ] **Step 2: Run both — verify failure** (the symlink is currently created).
- [ ] **Step 3: Implement.** In both installers' part-materialize loop, skip the flat-symlink step for the `gui` part key only (still materialize it into the package dir; still symlink headless/relay/workspace and the bins). Leave `linkIndex`/`link_index` in place for the other surfaces.
- [ ] **Step 4: Both suites green** (vitest lifecycle + cargo, zero warnings).
- [ ] **Step 5: Commit** — "install stops making the gui-extensions symlink; the loader reads the folder".

### Task 3: Migration removes existing `gui-extensions` symlinks

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/package_migrate.rs` (`migrate_flat_installs`)
- Test: cargo test in `package_migrate.rs`

**Interfaces:**
- Produces: after migration, a name with a `packages/<name>/` gui part has no `gui-extensions/<name>.js` entry. Idempotent.
- Consumes: the migration's existing per-name loop.

- [ ] **Step 1: Failing cargo test.** Seed an old-shape gui symlink + package dir, migrate, assert the symlink is gone and the package gui part remains:

```rust
#[test]
fn migration_removes_a_dead_gui_extensions_symlink() {
    let home = tempfile::tempdir().unwrap();
    let pkg = home.path().join("packages").join("bazaar");
    std::fs::create_dir_all(pkg.join("dist")).unwrap();
    std::fs::write(pkg.join("dist").join("gui.js"), "gui").unwrap();
    std::fs::write(pkg.join("package.json"),
        r#"{"name":"@fezchat/bazaar","version":"0.1.0","fez":{"parts":{"gui":"dist/gui.js"}}}"#).unwrap();
    std::fs::create_dir_all(home.path().join("gui-extensions")).unwrap();
    std::os::unix::fs::symlink(pkg.join("dist").join("gui.js"),
        home.path().join("gui-extensions").join("bazaar.js")).unwrap();
    let settings = serde_json::json!({ "extensionPermissions": { "bazaar": ["ui"] } });

    migrate_flat_installs(home.path(), &settings).unwrap();
    assert!(!home.path().join("gui-extensions").join("bazaar.js").exists());
    assert!(pkg.join("dist").join("gui.js").exists());
    migrate_flat_installs(home.path(), &settings).unwrap(); // idempotent, no panic
}
```

- [ ] **Step 2: Run — verify failure.**
- [ ] **Step 3: Implement.** In the migration, after a name's package dir is confirmed present, if `gui-extensions/<name>.js` exists and is owned (symlink resolving into `packages/<name>/`) OR is a plain file, remove it. Tolerate absence (idempotent). Do not touch other surfaces' symlinks.
- [ ] **Step 4: `cargo test` green, zero warnings.**
- [ ] **Step 5: Commit** — "migration drops the now-dead gui-extensions symlinks".

### Task 4: The mount-bridge signature and the return classifier

**Files:**
- Modify: `packages/fez-extension-api/src/gui.ts` (the six UI-returning registration signatures)
- Create: `packages/fez-desktop/src/mount-result.ts` (pure classifier)
- Test: `packages/fez-evals/tests/mount-result.test.ts`

**Interfaces:**
- Produces: `type Dispose = () => void;` and the widened callback type `MountRender = (host?: HTMLElement) => ReactNode | Dispose | void`, applied to `registerNavView`, `registerThreadView`, `registerSettingsPanel`, `registerPageView`, `registerBlockRenderer`, `registerArtifactAction`. Plus `classifyMountResult(result): { dispose?: Dispose; element?: ReactNode }` in `mount-result.ts`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test** (`mount-result.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { classifyMountResult } from "../../fez-desktop/src/mount-result.js";

describe("classifyMountResult", () => {
  it("a function is a disposer (mount form)", () => {
    const fn = () => {};
    expect(classifyMountResult(fn)).toEqual({ dispose: fn });
  });
  it("a React element is legacy content to render", () => {
    const el = { $$typeof: Symbol.for("react.element"), type: "div" };
    expect(classifyMountResult(el)).toEqual({ element: el });
  });
  it("void/undefined is neither", () => {
    expect(classifyMountResult(undefined)).toEqual({});
    expect(classifyMountResult(null)).toEqual({});
  });
  it("a plain object that is not a React element is not treated as content", () => {
    expect(classifyMountResult({ foo: 1 })).toEqual({});
  });
});
```

- [ ] **Step 2: Run — verify it fails** (module missing).
- [ ] **Step 3: Implement `classifyMountResult`:** if `typeof result === "function"` → `{ dispose: result }`; else if it is a React element (`result && typeof result === "object" && "$$typeof" in result`) → `{ element: result }`; else `{}`. Widen the six signatures in `gui.ts` to `MountRender` (keep the existing `El`/`ReactNode` return in the union so current extensions type-check). Update the mirror impl types in `gui-extensions.ts` to accept the widened callback.
- [ ] **Step 4: Run — green.** Confirm `@fezchat/extension-api` and `fez-desktop` still `tsc --noEmit` clean (the widened union must not break existing element-returning registrations).
- [ ] **Step 5: Commit** — "the view callback can take a host node and return a disposer; a returned element is still legacy".

### Task 5: `MountPoint` runs the callback; host render sites route through it

**Files:**
- Create: `packages/fez-desktop/src/MountPoint.tsx`
- Modify: `packages/fez-desktop/src/App.tsx` (the nav-view render site ~line 1278, and the other UI-returning sites)
- Modify: `packages/fez-desktop/src/gui-extensions.ts` (store the widened callback)
- Verify: the running app (component-render is verified live per the repo norm)

**Interfaces:**
- Consumes: `classifyMountResult` (Task 4), the widened callbacks (Task 4), the loader (Task 1).
- Produces: `<MountPoint render={cb} />` — a component that owns a container `<div>`, calls `cb(container)` once mounted, renders a returned element into the container (host React) or stores a returned disposer, and on unmount disposes/unrenders.

- [ ] **Step 1: Write `MountPoint`.** A `<div ref>`; in a `useEffect` (empty deps), call `const r = classifyMountResult(render(ref.current!))`; if `r.dispose`, keep it for cleanup; if `r.element`, render it into `ref.current` via a host React portal (`createPortal(r.element, ref.current)`) held in state; cleanup calls `r.dispose?.()` and clears the portal. Guard re-entrancy (StrictMode double-invoke in dev): dispose before re-mount.

```tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { classifyMountResult, type MountRender } from "./mount-result";

export function MountPoint({ render }: { render: MountRender }) {
  const host = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<React.ReactNode>(null);
  useEffect(() => {
    if (!host.current) return;
    const { dispose, element } = classifyMountResult(render(host.current));
    if (element) setPortal(createPortal(element, host.current));
    return () => { dispose?.(); setPortal(null); };
  }, [render]);
  return <div ref={host} style={{ display: "contents" }}>{portal}</div>;
}
```

- [ ] **Step 2: Route the render sites.** Replace `nav.render()` (App.tsx:1278) with `<MountPoint render={nav.render} />`, and the same for the other UI-returning surfaces where the host renders an extension result inline (thread view, page view, settings panel, block renderer, artifact action — wherever a stored `render` is invoked). Legacy element-returning extensions now flow through the `element` branch; mount-form ones through `dispose`.
- [ ] **Step 3: Verify in the running app.** `npm run tauri dev` (or the dev flow). Confirm: (a) an existing element-returning extension (the installed bazaar/wallet panel) still renders and re-renders; (b) switching away and back mounts/unmounts cleanly (no duplicate DOM, no console errors); (c) StrictMode dev double-mount does not leak. Capture a screenshot of a working panel.
- [ ] **Step 4: `tsc --noEmit` clean** for `fez-desktop`.
- [ ] **Step 5: Commit** — "MountPoint gives each extension view a node; a returned element still renders, a returned disposer owns cleanup".

### Task 6: Prove the mount form end to end, and the real-machine flip

**Files:** none (a throwaway demo extension + operational verification).

- [ ] **Step 1: Write a throwaway mount-form gui part** under the scratchpad: an `activate(api)` that `registerNavView`s a callback which `createRoot(host).render(...)`s a trivial React tree of its OWN React and returns `() => root.unmount()`. Build it (esbuild IIFE, `--global-name=__fezExt`), drop it into a test `packages/<demo>/` with a manifest declaring `fez.parts.gui`, and load it in the running app.
- [ ] **Step 2: Verify** the demo view: it mounts (its own React root renders), switching away calls the disposer (unmount runs — log it), and it coexists with a legacy element-returning extension in the same session. Screenshot both.
- [ ] **Step 3: Real-machine loader flip.** Rebuild the desktop app (`scripts/build-signed.sh`, swap `/Applications/fez.app`, relaunch — the established flow) so the new loader + migration run against the real `~/.fez`. Confirm: the installed extensions (bazaar et al.) still appear and render; `~/.fez/gui-extensions/` is emptied of the migrated symlinks; the package-dir gui parts are what load.
- [ ] **Step 4: Report.** Any failure reverts the app swap (previous `fez.app`) and files the fix.

## Self-review

- Spec coverage: §1 loading via `packages/*/` (T1), no gui symlink on install (T2) + migration removal (T3); §2 separation-as-manifest-keys is implicit in reading `fez.parts.gui` (T1); §3 mount model via the widened callback + `MountPoint`, with the element-return bridge so no extension breaks (T4/T5), proven with a real mount-form part (T6). §4/§7 (Tailwind, `@fezchat/ui`, scaffold) are explicitly Plan 2 — not covered here by design.
- No-broken-window: T1–T3 ship together (loader reads folder, install/migration drop the symlink) and element-returning extensions keep rendering through T5's bridge; T6 flips the real machine only after the branch is green.
- The `(name, code)` loader contract is preserved (T1), so the frontend loader is untouched — the change is contained to `list_gui_extensions`.
- Component-render tasks (T5) verify in the running app per the repo norm; the pure logic (T1 scanner, T4 classifier) is unit-tested.
