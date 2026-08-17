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
// Harness/persona/skill resolution — what a standing agent script (run via
// `fez run`) needs to dispatch instructions the same way the TUI does.
export { findHarness, registerBuiltinHarnesses, listHarnesses, detectHarnesses, registerHarness, invokeWithRetry, classifyTurnError, SESSION_TIMEOUTS, type HarnessAdapter, type HarnessSession, type HarnessUpdate, type TimeoutOptions, type TurnErrorKind } from "./harness.js";
export { findPersona, listPersonas, type Persona } from "./personas.js";
export { findMcpServer, registerMcpServer } from "./mcp-servers.js";
export { getKey, setKey, loadOrCreateKey, listKeys, exportKey, importKey } from "./keys.js";
export { loadSettings, saveSettings, resolveRelay, DEFAULT_RELAY } from "./settings.js";
export { isValidSlug, conversationKey, engramDTag, parseBodyStrict, bodyIsValid, validateEngram, selectHead, engramHeads, buildEngramEvent, type EngramBody, type ValidEngram } from "./engram.js";
export { buildDmWraps, unwrapDm, DM_FUZZ_WINDOW_S, type DmRumor } from "./dm.js";
export type { FezExtensionAPI, FezExtension, NostrAccess, PanelHandle, InputHandler } from "./extensions.js";
