/**
 * Fez SDK — decentralized MCP for agents.
 *
 * Build agents that can discover and call other agents over Nostr.
 *
 * ```typescript
 * import { Agent } from "@fez/protocol";
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

export { Agent, type AgentConfig, type TaskPayload, type TaskResult } from "./agent.js";
export { CapabilityClient, type ClientConfig, type Capability, type TaskOptions, type TaskResult as ClientTaskResult } from "./client.js";
export { RelayConnection, type RelayOptions } from "./relay.js";
export { FezTUI } from "./tui.js";
export { PackageManager, type FezPackage, type FezManifest } from "./package-manager.js";
export * from "./kinds.js";
/** Trust primitives: what a tool call risks, and what an extension may do. */
export { classifyCommand, classifyToolCall, type RiskLevel, type RiskVerdict } from "./command-risk.js";
export {
  parsePermissions,
  describePermission,
  consentLines,
  networkAllowed,
  has as hasPermission,
  LEGACY_GRANT,
  type PermissionId,
  type PermissionInfo,
} from "./extension-permissions.js";
// Harness/persona/skill resolution — what a standing agent script (run via
// `fez run`) needs to dispatch instructions the same way the TUI does.
export { findHarness, registerBuiltinHarnesses, listHarnesses, detectHarnesses, registerHarness, invokeWithRetry, classifyTurnError, SESSION_TIMEOUTS, setRiskPolicy, type RiskPolicy, type HarnessAdapter, type HarnessSession, type HarnessUpdate, type TimeoutOptions, type TurnErrorKind } from "./harness.js";
export { findPersona, listPersonas, validatePersonaFile, mergeDefaults, KNOWN_EXTRA_KEYS, type Persona, type PersonaValidation } from "./personas.js";
export { findMcpServer, registerMcpServer, loadMcpServersFromSettings } from "./mcp-servers.js";
export { getKey, setKey, loadOrCreateKey, listKeys, exportKey, importKey } from "./keys.js";
export { loadSettings, saveSettings, resolveRelay, DEFAULT_RELAY } from "./settings.js";
export { isValidSlug, conversationKey, engramDTag, parseBodyStrict, bodyIsValid, validateEngram, selectHead, engramHeads, buildEngramEvent, type EngramBody, type ValidEngram } from "./engram.js";
export { buildDmWraps, buildGroupDmWraps, unwrapDm, dmConvoKey, DM_FUZZ_WINDOW_S, type DmRumor } from "./dm.js";
export { pairSend, pairReceive, deriveSas, buildPairingUri, parsePairingUri, PAIRING_URI_PREFIX, type PairingCallbacks } from "./pairing.js";
export type { FezExtensionAPI, FezExtension, NostrAccess, PanelHandle, InputHandler, ScheduledTask, ScheduledTaskContext } from "./extensions.js";
/** Background-task plumbing: the sentinel loads extensions and drains their scheduled tasks. */
export { loadExtensions, registeredScheduledTasks, setNostrBackend } from "./extensions.js";
