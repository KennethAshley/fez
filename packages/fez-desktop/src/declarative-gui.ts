import { BUILT_IN_DEFAULT } from "./theme-default";

type Palette = Record<string, string>;
export type ProcessPhase = "missing" | "working" | "ready" | "error";
export interface ProcessSettings {
  type: "process";
  description: string;
  bin: string;
  job: string;
  status: { args: string[]; labels: Record<ProcessPhase, string>; checkingMessage: string; stoppedMessage: string };
  actions: Array<{
    operation: "spawn" | "run"; label: string; args?: string[]; env?: Record<string, string>;
    visibleWhen?: ProcessPhase[]; enabledWhen: ProcessPhase[]; successMessage: string;
  }>;
  hints?: Array<{ text: string; phases?: ProcessPhase[] }>;
}
export interface AgentSelectSettings {
  type: "agent-select";
  preference: string;
  label: string;
  description: string;
  emptyMessage: string;
  defaults: "identity-hash";
  options: Array<{ id: string; name: string; previewUrl?: string }>;
}
export type SettingsSection = ProcessSettings | AgentSelectSettings;
export interface DeclarativeGui {
  themes?: Record<string, { light: Palette; dark: Palette }>;
  settings?: SettingsSection[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error("Unsupported settings fields");
}
function text(value: unknown, max = 2048): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw Error("Invalid settings text");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw Error("Invalid settings identifier");
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw Error("Invalid settings list");
}
const PHASES: ProcessPhase[] = ["missing", "working", "ready", "error"];
function phases(value: unknown): asserts value is ProcessPhase[] {
  list(value, 4);
  if (value.some(v => !PHASES.includes(v as ProcessPhase)) || new Set(value).size !== value.length) throw Error("Invalid process phase");
}
function args(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 32) throw Error("Invalid process arguments");
  for (const arg of value) text(arg, 1024);
}

function settings(value: unknown): SettingsSection[] {
  list(value, 8);
  for (const section of value) {
    if (!record(section)) throw Error("Invalid settings section");
    text(section.description);
    if (section.type === "process") {
      fields(section, ["type", "description", "bin", "job", "status", "actions", "hints"]);
      identifier(section.bin); identifier(section.job);
      fields(section.status, ["args", "labels", "checkingMessage", "stoppedMessage"]);
      args(section.status.args);
      fields(section.status.labels, PHASES);
      for (const phase of PHASES) text(section.status.labels[phase], 80);
      text(section.status.checkingMessage); text(section.status.stoppedMessage);
      list(section.actions, 8);
      for (const action of section.actions) {
        fields(action, ["operation", "label", "args", "env", "visibleWhen", "enabledWhen", "successMessage"]);
        text(action.label, 80); text(action.successMessage);
        phases(action.enabledWhen);
        if (action.visibleWhen !== undefined) phases(action.visibleWhen);
        if (action.operation === "run") {
          args(action.args);
          if (action.env !== undefined) throw Error("Run actions do not accept environment values");
        } else if (action.operation === "spawn") {
          if (action.args !== undefined || !record(action.env) || Object.keys(action.env).length > 16) throw Error("Invalid spawn environment");
          for (const [key, value] of Object.entries(action.env)) {
            if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || /^(?:PATH$|LD_|DYLD_|NODE_OPTIONS|BUN_)/.test(key)) throw Error("Invalid process environment name");
            text(value, 1024);
          }
        } else throw Error("Unsupported process action");
      }
      if (section.hints !== undefined) {
        list(section.hints, 8);
        for (const hint of section.hints) {
          fields(hint, ["text", "phases"]); text(hint.text);
          if (hint.phases !== undefined) phases(hint.phases);
        }
      }
    } else if (section.type === "agent-select") {
      fields(section, ["type", "preference", "label", "description", "emptyMessage", "defaults", "options"]);
      identifier(section.preference); text(section.label, 80); text(section.emptyMessage);
      if (section.defaults !== "identity-hash") throw Error("Unsupported default selection");
      list(section.options, 64);
      const ids = new Set<string>();
      for (const option of section.options) {
        fields(option, ["id", "name", "previewUrl"]);
        identifier(option.id); text(option.name, 80);
        if (ids.has(option.id)) throw Error("Duplicate selection option");
        ids.add(option.id);
        if (option.previewUrl !== undefined) {
          text(option.previewUrl);
          const url = new URL(option.previewUrl);
          if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw Error("Preview requires an HTTPS URL without credentials");
        }
      }
    } else throw Error("Unsupported settings section");
  }
  return value as unknown as SettingsSection[];
}

function palette(value: unknown): Palette {
  if (!record(value) || !Object.keys(value).length) throw Error("Theme palette must be a nonempty object");
  for (const [key, color] of Object.entries(value)) {
    if (!Object.hasOwn(BUILT_IN_DEFAULT.dark, key) || typeof color !== "string") throw Error(`Unsupported theme token: ${key}`);
    // Fonts and layout stay host-controlled. Existing theme packs repeat
    // these defaults; accepting them preserves their exact palettes.
    const valid = key === "--font-mono" || key === "--font-ui" || key === "--measure-read" || key === "--measure-scan"
      ? color === BUILT_IN_DEFAULT.dark[key]
      : /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color);
    if (!valid) throw Error(`Unsupported theme value for ${key}`);
  }
  return value as Palette;
}

/** Parse the entire bounded payload before any registration or painting. */
export function parseDeclarativeGui(raw: string): DeclarativeGui {
  if (raw.length > 256 * 1024) throw Error("Declarative GUI data exceeds 256 KiB");
  const data: unknown = JSON.parse(raw);
  fields(data, ["themes", "settings"]);
  if (!Object.keys(data).length) throw Error("Declarative GUI requires themes or settings");
  const result: DeclarativeGui = {};
  if (data.settings !== undefined) result.settings = settings(data.settings);
  if (data.themes === undefined) return result;
  if (!record(data.themes)) throw Error("Declarative GUI requires a themes object");
  const entries = Object.entries(data.themes);
  if (!entries.length || entries.length > 64) throw Error("Declarative GUI requires 1–64 themes");
  result.themes = Object.fromEntries(entries.map(([name, pack]) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || name === "default") throw Error(`Invalid theme name: ${name}`);
    if (!record(pack) || Object.keys(pack).length !== 2 || !Object.hasOwn(pack, "light") || !Object.hasOwn(pack, "dark")) {
      throw Error(`Theme ${name} requires light and dark palettes`);
    }
    return [name, { light: palette(pack.light), dark: palette(pack.dark) }];
  }));
  return result;
}
