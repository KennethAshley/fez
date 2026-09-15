/**
 * The compat contract between a package and the fez that hosts it.
 *
 * A package built against a newer FezExtensionAPI must fail AT INSTALL,
 * naming both versions — not load fine and hit an undefined method three
 * layers into someone's afternoon. `fez.minFezVersion` in the manifest is
 * the package's claim; this module is the check, run by `fez install`
 * and `fez link`. Absent field means no claim (packages predating the
 * field keep installing), same posture as LEGACY_GRANT.
 */

/** The ONE place fez states its own version — cli.ts --version reads it too. */
// 0.2.3 adds the isolated GUI starter and its shared desktop styles.
export const FEZ_VERSION = "0.2.3";

/** Numeric x.y.z compare; missing parts are zero. NaN parts poison to NaN via the caller's guard. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const WELL_FORMED = /^\d+(\.\d+){0,2}$/;

/**
 * Null when the host may load the package; otherwise the message shown
 * to the user. An unparseable requirement refuses too — a package
 * declaring garbage is asking for a check we cannot perform.
 */
export function minFezVersionError(required: string | undefined, hostVersion: string = FEZ_VERSION): string | null {
  if (required === undefined) return null;
  if (!WELL_FORMED.test(required)) {
    return `declares minFezVersion "${required}", which is not an x.y.z version — refusing to guess`;
  }
  if (compareSemver(hostVersion, required) < 0) {
    return `needs fez ≥ ${required}, you have ${hostVersion} — update fez and retry`;
  }
  return null;
}
