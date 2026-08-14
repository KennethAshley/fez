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
