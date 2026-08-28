# Extension format and developer experience

**Status:** design, discussed 2026-08-28. Companion to
`2026-08-27-extension-packages-design.md` (approved) — that spec settles
what an *installed* extension is (one package directory as source of
truth, flat directories as a load index, namespaced bins). This one
settles what a *published* extension is, what writing one feels like,
and how an artifact proves where it came from.

## What other systems do, and what each one teaches

**VS Code** — `package.json` IS the manifest (`contributes`, `engines`),
one directory per installed extension, `.vsix` = a zip of the package.
Lesson kept: manifest-in-package.json is the best authoring DX in the
industry; fez's `fez` block already copies it — keep it. Lesson avoided:
Marketplace signing was retrofitted years in, painfully, after typosquat
and malware incidents. Signing must exist BEFORE the gallery is public,
not after the first incident.

**Chrome / WebExtensions** — `manifest.json` beside the code; the
permission list in the manifest is what the install dialog shows (fez
already mirrors this); a CRX is a signed zip and the extension ID is
DERIVED FROM THE SIGNING KEY, so an update signed by anyone else is
structurally impossible. Lesson: identity should be the key, not the
name. fez has a better key than Google's: the publisher's npub.

**Obsidian** — the closest analog to fez's current reality: one
directory per plugin holding `manifest.json` + ONE bundled `main.js` +
optional `styles.css`. The single-bundle rule is community consensus and
nobody complains — esbuild one-liner, done. Lesson: directory packaging
and single-file code are not in tension; the directory is for manifest
and assets, the code stays one file per surface. Anti-lesson: their
community list is a PR to a central repo — fez's answer is the relay.

**Raycast / Figma** — manifest + one bundled artifact, again. Figma runs
plugins in a sandbox; Raycast reviews centrally. fez's equivalent
boundary is the permission-gated API (per the existing design: grants
gate the API, not the files).

**MCPB (Anthropic's MCP bundles)** — `manifest.json` + zip, exactly the
shape proposed here, for the ecosystem fez skills already bridge to.
Converging on "manifest + archive" keeps a future fez↔MCPB adapter
mechanical.

**Buzz** — skills are directories (SKILL.md + supporting files, loaded
on demand); relay-backed skills are treated as untrusted input and gated
on explicit request. Both stances port: directories for anything with
supporting files, and relay-fetched artifacts are untrusted until
verified.

The survey's summary: every mature system landed on **manifest + one
bundled artifact per entry point, packaged as a directory, distributed
as a signed archive**. fez is already two-thirds there; the missing
third is the signature.

## The authoring experience

The dev-side contract stays what it is, because it is already the
industry's best pattern:

- **A fez extension is a normal npm package.** `package.json` carries
  the `fez` block (parts, permissions, minFezVersion). No second
  manifest file to keep in sync while developing — the installed
  `manifest.json` (below) is DERIVED at pack time, never hand-written.
- **One bundled file per surface**, in `dist/`. Non-negotiable, per the
  approved spec's non-goals: no node_modules at the destination, ever.
- **`fez link --watch`** stays the inner loop (edit → rebuild → reload).

Two additions carry the DX the rest of the way:

### `fez create extension` (scaffold)

Emits the canonical layout so the first five minutes need no docs:

```
my-extension/
  package.json          name, fez block, scripts wired to `fez pack`
  src/gui.ts            activate(api) stub with the themed-tokens rule
  src/headless.ts       optional
  assets/               optional — files, not data-URIs
  README.md
```

The stub teaches the two rules people otherwise learn by bug: colors are
`var(--token, fallback)` never bare hex (the bazaar's lesson), and
`api.*` capabilities are absent-when-ungranted, never assumed.

### `fez pack` (the vsce analogy)

Today every extension hand-writes its own esbuild scripts (the bazaar's
package.json carries four). `fez pack` owns the build:

- bundles each declared part to `dist/` (esbuild, iife for gui, esm for
  headless/relay) — authors may still bring their own build; pack only
  fills in for parts without one
- derives `manifest.json`: name, version, parts, declared permissions,
  minFezVersion, plus a sha256 per artifact
- signs the manifest with the publisher's nostr key (from the keychain,
  same custody as everything else)
- emits `<name>-<version>.fezx` — a tarball of the package directory,
  npm-compatible on purpose so `npm publish` keeps working unchanged

## The published unit

```
manifest.json           derived + signed; the ONLY file install trusts
package.json            as authored (dev metadata, npm compatibility)
dist/gui.js             one bundle per declared part
dist/headless.js
bin/<command>           compiled binaries, hashed like everything else
assets/…                referenced by parts at runtime, hashed
```

`manifest.json` schema (v1):

```json
{
  "format": 1,
  "name": "fez-bazaar",
  "version": "0.2.0",
  "publisher": "<npub hex>",
  "fez": { "parts": {…}, "permissions": […], "minFezVersion": "0.4.2" },
  "artifacts": { "dist/gui.js": "sha256:…", "bin/fez-bazaar-miner": "sha256:…" },
  "sig": "<schnorr over the canonical manifest body>"
}
```

Verification at install: every artifact hashes to its manifest entry,
and the signature verifies against `publisher`. This is the same move
the bazaar's attestations made this week — the artifact carries its own
proof, so the TRANSPORT stops being the trust boundary. That is what
makes the third install source safe:

- `fez install <npm-spec>` — today's path, now also verified
- `fez install <file.fezx>` — side-loading, verified
- `fez install <nostr address>` — the gallery's future: a signed listing
  event pointing at the archive on Blossom. Decentralized distribution
  becomes possible BECAUSE the trust moved into the artifact.

## Identity and updates

- A publisher is an npub. First install binds `name → publisher` on the
  machine (trust-on-first-use, Chrome's key-derived-ID property without
  Google in the middle).
- An UPDATE whose manifest is signed by a different key is refused, by
  name: "fez-bazaar is published by <name/npub>; this archive is signed
  by someone else." Re-keying is an explicit `--trust-new-publisher`
  decision, never silent.
- The gallery shows the publisher identity the same way channels show
  authorship — extension trust becomes legible with machinery users
  already understand.

## What deliberately does not change

Restating the approved spec's non-goals, which all survive contact with
the prior art: one pre-bundled file per surface (no dependency trees at
the destination); no `FezExtensionAPI` changes; gui parts keep loading
into the host document from the flat index; grants stay in
`settings.json` as the user's decision, distinct from the manifest's
declarations.

## Sequencing

1. **Land the 08-27 spec first** (package dir, load index, bin
   namespacing, one install impl). This spec's pieces bolt onto that
   directory; building them against the flat layout would be building
   them twice.
2. **`fez pack` + derived-manifest + hashes** — no signing yet; installs
   start verifying hashes (integrity without identity).
3. **Signing + TOFU publisher binding** — before the repo/gallery goes
   public. This is the deadline-shaped piece.
4. **Scaffold + relay install source** — after, at leisure.

## Open questions

1. **Canonical manifest bytes for signing** — JCS-style key-sorted JSON,
   or sign the manifest as a nostr EVENT (kind + content = manifest)?
   The event form gets relay listing and verification for free and
   reuses existing code paths; leaning that way.
2. **Assets access from gui parts** — parts render in the webview; files
   in the package dir need a bridge (Tauri asset scope or an
   `api.assets.url(name)` accessor). Not needed for step 1-3; decide
   when the first asset-hungry extension exists (Qud sprites are the
   obvious customer).
3. **`.fezx` vs plain `.tgz`** — same bytes either way; the extension
   only buys double-click affordance later. Default to `.tgz` until a
   desktop "install from file" flow wants the association.
