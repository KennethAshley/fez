/**
 * Fez SDK — decentralized MCP for agents.
 *
 * Build agents that can discover and call other agents over Nostr.
 *
 * ```typescript
 * import { Agent } from "@fezchat/protocol";
 *
 * const agent = await Agent.create({
 *   relay: "wss://relay.example.com",
 *   name: "my-agent",
 *   supportedTasks: ["echo"],
 * });
 *
 * agent.onTask(async (task) => {
 *   await task.reply({
 *     status: "success",
 *     result: { echo: task.content.instruction },
 *   });
 * });
 *
 * await agent.start();
 * ```
 */

export { Agent, type AgentConfig, type TaskPayload, type TaskResult } from "./agent/agent.js";
export { CapabilityClient, type ClientConfig, type Capability, type TaskOptions, type TaskResult as ClientTaskResult } from "./protocol/client.js";
export { RelayConnection, type RelayOptions } from "./protocol/relay.js";
export { mentionedNames, mentionTags } from "./agent/mentions.js";
export { makeChannels, cleanSource, type ChannelsAccess, type ChannelSpec, type ChannelRef } from "./protocol/channels.js";
export { KIND_HTTP_AUTH, buildNip98Header, verifyNip98Header, type Nip98Result, type VerifyOptions } from "./protocol/nip98.js";
export { FezTUI } from "./cli/tui.js";
export { PackageManager, type FezPackage, type FezManifest } from "./extensions/package-manager.js";
export * from "./protocol/kinds.js";
/** Trust primitives: what a tool call risks, and what an extension may do. */
export { classifyCommand, classifyToolCall, type RiskLevel, type RiskVerdict } from "./agent/command-risk.js";
export {
  parsePermissions,
  describePermission,
  consentLines,
  networkAllowed,
  has as hasPermission,
  LEGACY_GRANT,
  type PermissionId,
  type PermissionInfo,
} from "./extensions/extension-permissions.js";
// Harness/persona/skill resolution — what a standing agent script (run via
// `fez run`) needs to dispatch instructions the same way the TUI does.
export { findHarness, registerBuiltinHarnesses, listHarnesses, detectHarnesses, registerHarness, invokeWithRetry, classifyTurnError, SESSION_TIMEOUTS, setRiskPolicy, type RiskPolicy, type HarnessAdapter, type HarnessSession, type HarnessUpdate, type PromptImage, type PromptInput, type TimeoutOptions, type TurnErrorKind } from "./agent/harness.js";
export { findPersona, listPersonas, validatePersonaFile, mergeDefaults, parseSkillEntries, KNOWN_EXTRA_KEYS, type Persona, type PersonaValidation } from "./identity/personas.js";
/** Where a declared skill comes from — see skill-source.ts on why a bare name resolves to nothing. */
export { parseSkillSource, describeSkillSpec, wellKnownSource, installHint, machineLocalPath, SOURCE_SCHEMES, type SkillSpec } from "./extensions/skill-source.js";
export { findMcpServer, registerMcpServer, loadMcpServersFromSettings } from "./extensions/mcp-servers.js";
export { getKey, setKey, loadOrCreateKey, listKeys, exportKey, importKey } from "./identity/keys.js";
/** A background process needs the PATH a person has, not the one launchd gives it. */
export { adoptUserPath, whichBinary } from "./shared/user-path.js";
export { loadSettings, saveSettings, resolveRelay, resolveRelays, DEFAULT_RELAY } from "./shared/settings.js";
export { parseRespondTo, authorAllowed, describeAuthorPolicy, type AuthorPolicy, type AuthorMode } from "./identity/author-gate.js";
export { untrustedValue, UNTRUSTED_CONTENT_NOTICE } from "./shared/prompt-values.js";
export {
  registerSystemPromptSection,
  systemPromptSections,
  clearSystemPromptSection,
  composeSystemPrompt,
  isPrivileged,
  type SystemPromptSection,
  type SystemPromptMode,
} from "./agent/system-prompt.js";
export { isValidSlug, conversationKey, engramDTag, parseBodyStrict, bodyIsValid, validateEngram, selectHead, engramHeads, buildEngramEvent, type EngramBody, type ValidEngram } from "./agent/engram.js";
export { buildDmWraps, buildGroupDmWraps, unwrapDm, dmConvoKey, DM_FUZZ_WINDOW_S, type DmRumor } from "./protocol/dm.js";
export { pairSend, pairReceive, deriveSas, buildPairingUri, parsePairingUri, PAIRING_URI_PREFIX, type PairingCallbacks } from "./identity/pairing.js";
export type { FezExtensionAPI, FezExtension, NostrAccess, PanelHandle, InputHandler, ScheduledTask, ScheduledTaskContext, WorkspaceAccess } from "./extensions/extensions.js";
/** Background-task plumbing: the sentinel loads extensions and drains their scheduled tasks. */
export { loadExtensions, registeredScheduledTasks, setNostrBackend, setWorkspaceBackend } from "./extensions/extensions.js";
/** NIP-11 — the workspace's identity card: who owns this relay, and what it advertises. */
export { fetchRelayInfo, httpFromRelay, type RelayInfo } from "./protocol/nip11.js";
