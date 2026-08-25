import fs from "node:fs";
import path from "node:path";
import fixPath from "fix-path";

/**
 * Give a background process the PATH a person actually has.
 *
 * launchd hands a service `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. systemd
 * is similarly bare. So anything a user installed — Homebrew, uv, cargo,
 * pipx, nvm — is invisible to the sentinel even though it is right there
 * in a terminal. `gh` at /opt/homebrew/bin/gh is not "missing"; it is
 * unreachable from a process nobody gave a login environment to.
 *
 * The symptom is the worst kind: an extension shells out, gets ENOENT,
 * and reports the tool as not installed. You then go install a tool that
 * was already installed, and nothing changes.
 *
 * fix-path reads the login shell's PATH once and adopts it — the same
 * thing VS Code and every Electron app do, for the same reason. Calling
 * it in ONE place fixes every extension at once, including ones written
 * by people who have never heard of this problem. That is the argument
 * for putting it in core rather than teaching each extension to hunt for
 * its own binary.
 *
 * Safe to call more than once; safe when the shell can't be read (it
 * leaves PATH alone). Never call it in the GUI's webview — there is no
 * shell there, and nothing in a webview shells out.
 */
export function adoptUserPath(): void {
  const before = process.env.PATH ?? "";
  try {
    fixPath();
  } catch {
    // A machine whose login shell won't answer keeps the PATH it had.
    // Degrading to the stripped one is fine; crashing the sentinel over
    // a PATH lookup is not.
    return;
  }
  if (process.env.PATH !== before) {
    const gained = (process.env.PATH ?? "").split(":").filter((dir) => dir && !before.split(":").includes(dir));
    if (gained.length > 0) console.log(`   ⌁ PATH: +${gained.length} user dir(s) — ${gained.slice(0, 3).join(", ")}${gained.length > 3 ? "…" : ""}`);
  }
}

/**
 * Is an external binary reachable? The question an extension's declared
 * `requires` actually asks.
 *
 * Walks PATH itself rather than shelling out to `which`. No subprocess,
 * works the same on every platform, and — the reason it is written this
 * way — it cannot fail for a reason unrelated to the question. The first
 * version called `/usr/bin/which` through `require("node:child_process")`
 * inside an ESM module; the require threw, the catch swallowed it, and
 * doctor reported gh "not found" while gh sat in /opt/homebrew/bin. A
 * lookup whose failure mode is indistinguishable from a true negative is
 * worse than no lookup.
 *
 * Resolved against the CURRENT PATH, so call adoptUserPath() first or
 * this answers for the stripped environment — the very bug this module
 * exists to fix.
 */
export function whichBinary(name: string): string | undefined {
  // A manifest is data from a package someone else wrote: only a bare
  // binary name, never a path.
  if (!/^[\w.-]+$/.test(name)) return undefined;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // PATHEXT on Windows; a bare name is right everywhere else.
  const candidates = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch { /* not here, or not executable */ }
    }
  }
  return undefined;
}
