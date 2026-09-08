import type { ConfigField } from "@fezchat/extension-api";
type Val = string | number | boolean;

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
    if (stored && f.key in stored) out[f.key] = stored[f.key];
    else if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}
export function validateConfig(schema: ConfigField[] | undefined, values: Record<string, Val>): string | null {
  for (const f of schema ?? []) if (f.required && (values[f.key] === undefined || values[f.key] === "")) return f.label;
  return null;
}
