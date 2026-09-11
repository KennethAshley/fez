// Older personas used generated provider ids; new ones use the provider name.
const LEGACY: Record<string, string> = { "local-56105ece7a": "chutes", "local-ebfd09756a": "gm", "local-3ce36528bf": "anthropic", "local-d9617135d6": "openai", "local-76ef4ad6f0": "openrouter" };
export const providerId = (id: string) => LEGACY[id] ?? id;

/**
 * The v1 provider table (mirrors the Rust `provider_spec` list in
 * src-tauri/lib.rs). One row per pi-wireable model provider: the id is the
 * keychain namespace, keyName the env var agents resolve at spawn.
 */
export const PROVIDERS: {
  id: string;
  label: string;
  keyName: string;
  hint: string;
  /** Optional secrets shown alongside the key (saved only if filled in). */
  extraKeys?: Record<string, string>;
}[] = [
  { id: "chutes", label: "Chutes", keyName: "CHUTES_API_KEY", hint: "decentralized GPUs — chutes.ai" },
  {
    id: "anthropic",
    label: "Anthropic",
    keyName: "ANTHROPIC_API_KEY",
    hint: "api key from console.anthropic.com — workspace id only if your key is identity-linked",
    extraKeys: { ANTHROPIC_WORKSPACE_ID: "" },
  },
  { id: "openai", label: "OpenAI", keyName: "OPENAI_API_KEY", hint: "api key from platform.openai.com" },
  { id: "openrouter", label: "OpenRouter", keyName: "OPENROUTER_API_KEY", hint: "one key, many models — openrouter.ai" },
  { id: "gm", label: "GM", keyName: "GM_API_KEY", hint: "confidential frontier models — saygm.com" },
  { id: "actual", label: "Actual", keyName: "ACTUAL_API_KEY", hint: "your own machines as a private inference cluster — actual.inc (ac_ token from the dashboard)" },
  { id: "engy", label: "Engy", keyName: "ENGY_API_KEY", hint: "verified inference gateway (GLM, Qwen, DeepSeek) — engy.ai" },
];
