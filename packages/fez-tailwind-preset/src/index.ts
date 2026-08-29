import type { Config } from "tailwindcss";

/**
 * Every fez-* color utility resolves to a live theme token, so a class
 * name written by an extension follows the user's theme with no plumbing:
 * `bg-fez-surface` is `background-color: var(--bg1)`, and when the themes
 * system rewrites --bg1 on :root the utility repaints. This is why the
 * frozen-gruvbox class of bug is structurally impossible.
 */
const fez = {
  fg: "var(--fg)",
  dim: "var(--fg-dim)",
  surface: "var(--bg1)",
  elevated: "var(--bg2)",
  base: "var(--bg0)",
  mine: "var(--bg-mine)",
  rail: "var(--bg-rail)",
  accent: "var(--accent)",
  brand: "var(--brand)",
  green: "var(--green)",
  red: "var(--red)",
  yellow: "var(--yellow)",
  hairline: "var(--hairline)",
  field: "var(--field)",
} as const;

const preset: Partial<Config> = {
  theme: { extend: { colors: { fez } } },
};

export default preset;
