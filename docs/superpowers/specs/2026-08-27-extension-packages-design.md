# An installed extension keeps its package

**Status:** design, approved in conversation 2026-08-27. Not started.

## The question

"Should extensions be folders?"

They already are — on one of the two install paths. fez has two
implementations of install that disagree about what an installed
extension *is*, and the one the desktop uses throws the package away.

## What is actually on disk today

**The CLI** (`src/extensions/package-manager.ts`) keeps the package:

- `~/.fez/packages/npm/<name>/` or `~/.fez/packages/git/<name>/`
- `~/.fez/registry.json` records what is installed
- it even runs `npm install --omit=dev` in the package dir

**The desktop** (`install_package`, `packages/fez-desktop/src-tauri/src/lib.rs`)
untars into flat per-kind directories and keeps nothing else:

- `~/.fez/{gui-extensions,extensions,relay-extensions,workspace-providers}/<name>.js`
- `~/.fez/skills/<name>/`
- `~/.fez/bin/<command>` — a FLAT namespace shared by every package
- `~/.fez/extension-data/<name>.json`
- `settings.json`: `extensionPermissions`, `extensionVersions`,
  `extensionBins`, `mcpServers`

Its own comment states the consequence:

> Installed names are recorded in settings so uninstall can remove
> exactly these files (**the desktop has no package dir to re-read**).

Observed on a real machine 2026-08-27: `registry.json` lists zero
packages while `~/.fez/packages/npm/packages/fez-theme-fez/package.json`
exists — an orphan from the other path, with nothing tracking it.

## Why this matters more than tidiness

### 1. Authorization reads a mutable config, not the artifact

`spawn_extension_agent` (added 2026-08-27) decides whether an extension
may run a binary by reading `extensionPermissions` and `extensionBins`
from `settings.json`. Those are *cached manifest claims*, copied at
install time.

This was demonstrated, not theorised: to test the feature, a person
granted an extension the `processes` permission and declared its bin by
hand-editing `settings.json`. There was no package to check the claim
against, so the edit was authoritative.

The split should be:

- **the package** states what it *is* — parts, bins, declared permissions
- **settings** records what the user *decided* — which of those to grant

Today settings holds both, so a package's claims are only as trustworthy
as a JSON file anyone can edit.

### 2. Uninstall guesses

`remove_extension` probes twelve speculative paths — three name
candidates (`name`, `fez-name`, name minus `fez-`) across four
directories — because it cannot ask the package what it installed. The
`fez-` prefix tolerance exists to cover `fez link`-era filenames.

`packages/fez-evals/tests/package-lifecycle.test.ts` records what this
already cost: `fez remove` cleaned only the headless entry, so gui,
relay and workspace parts, bins, and the `backgroundExtensions` entry
outlived the package — and the desktop's uninstall disagreed with the
CLI's.

### 3. The bin namespace collides silently

`~/.fez/bin` is flat and shared. `install_package` validates that a
command name cannot escape the directory, but nothing stops two packages
shipping the same command — the second install overwrites the first, and
`extensionBins` then claims both own it. Uninstalling either removes a
binary the other still needs.

## Design

### Package directory is the source of truth

One directory per installed package, whichever path installed it:

```
~/.fez/packages/<name>/
  package.json         the real manifest, as published
  dist/…               the built parts, as shipped
  bin/…                the package's own binaries
```

Core answers "did this package ship this bin / declare this permission"
by reading `package.json` there, not by consulting `settings.json`.

`settings.json` keeps only the user's decision:
`extensionPermissions[<name>]` stays, as the *granted* subset. Delete
`extensionBins` and `extensionVersions` — both are manifest facts, and a
cached copy that can drift from its source is exactly the failure above.

### The flat directories become a load index

Startup should stay a directory read, not N manifest parses. Keep
`~/.fez/gui-extensions/<name>.js` and friends as symlinks (or copies)
into the package dir, written by install and rewritten by update. They
are a cache; the package dir is the record. Nothing at load time changes.

### Bins get namespaced on disk, flat on PATH

Binaries live at `~/.fez/packages/<name>/bin/<command>` and are
symlinked into `~/.fez/bin/<command>`. Install refuses a symlink that
would overwrite one belonging to another package, and says which package
owns it. Uninstall removes only symlinks that resolve into its own
package dir — so removing one package can no longer delete another's
binary.

### One install implementation, two callers

The desktop's Rust `install_package` and the CLI's `PackageManager`
must produce byte-identical layouts, or this reintroduces the
divergence it exists to remove. The lifecycle test already asserts
CLI/desktop agreement; extend it to cover the package dir, the symlink
index, and bin ownership.

## Migration

Extensions installed under the old layout have no package dir and their
manifests are gone. On first run after upgrade:

- for each name in `extensionPermissions`, synthesise
  `~/.fez/packages/<name>/package.json` from what settings recorded
  (`extensionBins` → `bin`, `extensionVersions` → `version`, the granted
  list → `fez.permissions`), and move the existing part files in
- mark each synthesised manifest `"fez": { "reconstructed": true }`, so
  it is visible that these claims came from settings rather than from a
  published package
- a later `fez update` replaces a reconstructed manifest with the real one

Do not silently trust a reconstructed manifest for a *new* grant: if a
package asks for a permission it did not hold before, require a real
install first. Otherwise migration launders the very edits this design
is meant to prevent.

## Non-goals

- **Dependency trees for bundled parts.** Extensions shipping one
  pre-bundled `.js` with no `node_modules` is a virtue — no install
  step, no resolution, no version conflicts. A package directory must
  not become a licence to `npm install` at load time. The CLI's existing
  `npm install --omit=dev` is for git/npm *sources*, not for parts.
- **Changing the extension API.** No `FezExtensionAPI` surface moves.
- **Changing how gui parts load.** They keep rendering into the host
  document from the same paths.

## Open questions

1. **Symlinks or copies for the load index?** Symlinks are cheap and
   self-healing; copies survive a package dir being moved and work if a
   filesystem or a future Windows port dislikes symlinks. Recommend
   symlinks with a copy fallback, decided at install and recorded.
2. **Does `~/.fez/packages/<name>` use the bare name or the npm name?**
   Today the CLI nests npm installs under
   `packages/npm/<name>/node_modules/@fezchat/<pkg>`. The bare,
   de-scoped name is what every other directory already keys on; picking
   anything else means a second name-normalisation rule.
3. **What happens to a package dir when only some parts are granted?**
   Probably nothing — grants gate the API, not the files — but it should
   be stated rather than assumed.

## Done when

- Installing from the gallery and from `fez install` produce the same
  directory layout, asserted by the lifecycle test
- `extension_may_spawn` reads the package manifest; `extensionBins` is
  gone from settings
- Two packages declaring the same bin name: the second install is
  refused with the owner named, and the test proves it
- Uninstall removes one directory plus its own symlinks, and a
  co-installed package still works afterwards
- An existing install survives upgrade with its grants intact and its
  manifest marked reconstructed
