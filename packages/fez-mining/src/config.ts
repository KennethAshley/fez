import type { ConfigField, SubnetMiner } from "@fezchat/extension-api";
type Val = string | number | boolean;

// `cmdConfigSet` stores whatever argv string it was given — a descriptor
// reading `ctx.config.someBoolean` untyped gets back the STRING "false",
// which is truthy in JS (bit gradients' refreshNodes: `"false" ? "True" :
// "False"` picked "True"). Coerce to the field's declared type here, once,
// so every descriptor gets a real boolean/number regardless of how the
// value arrived (form checkbox, CLI argv, or already-typed default).
// undefined = couldn't coerce (a non-numeric stored string for a "number"
// field) — the caller falls through to the field's default, same as an
// unset value.
function coerce(type: ConfigField["type"], v: Val): Val | undefined {
  if (type === "boolean") return v === true || v === "true";
  if (type === "number") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return String(v);
}

export function resolveConfig(
  schema: ConfigField[] | undefined,
  stored: Record<string, Val> | undefined,
  readSecret: (key: string) => string | undefined
): Record<string, Val> {
  const out: Record<string, Val> = {};
  for (const f of schema ?? []) {
    if (f.type === "secret") {
      const s = readSecret(f.key);
      if (s !== undefined) out[f.key] = s;
      continue;
    }
    let value = stored && f.key in stored ? coerce(f.type, stored[f.key]) : undefined;
    if (value === undefined && f.default !== undefined) value = coerce(f.type, f.default);
    if (value !== undefined) out[f.key] = value;
  }
  return out;
}
export function validateConfig(schema: ConfigField[] | undefined, values: Record<string, Val>): string | null {
  for (const f of schema ?? []) {
    const v = values[f.key];
    if (v === undefined || v === "") { if (f.required) return f.label; else continue; }
    if (f.type === "select" && f.options && !f.options.includes(String(v))) return f.label;
    if (f.type === "number" && !Number.isFinite(Number(v))) return f.label;
    if (f.pattern && !new RegExp(`^(?:${f.pattern})$`).test(String(v))) return f.label;
  }
  return null;
}

/** Shared by initial start and sentinel respawn, before either can spend. */
export function assertMinerPreflight(d: SubnetMiner, values: Record<string, Val>, network?: string): void {
  if (d.network && network !== d.network) {
    throw new Error(`${d.name} requires wallet network ${d.network}; found ${network ?? "unknown"}. Run: fez-wallet network ${d.network}`);
  }
  if (d.container && /REPLACED_AT_PUBLISH|@sha256:(?![a-f0-9]{64}$)/.test(d.container.image)) {
    throw new Error(`${d.name}: miner image is not published and digest-pinned yet`);
  }
  const invalid = validateConfig(d.config, values);
  if (invalid) throw new Error(`Invalid or missing miner config: ${invalid}`);
}
