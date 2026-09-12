import { Agent } from "../../../src/agent/agent.js";
import { CapabilityClient } from "../../../src/protocol/client.js";
import { KIND_AGENT_METADATA, KIND_AGENT_TASK, KIND_AGENT_PROGRESS, KIND_AGENT_RESULT } from "../../../src/protocol/kinds.js";
import { startRelay, type StoredEvent } from "../../../packages/fez-relay/src/relay.js";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";

export interface LocalTeam {
  roster: Record<string, string> & { buyer: string; lead: string };
  clients: Record<string, CapabilityClient>;
  agents: Record<string, Agent>;
  events: { receivedMs: number; event: StoredEvent }[];
  rootTaskId: string | null;
  start(): Promise<void>;
}

/** Fresh local identities; only buyer→lead roots and lead→specialist children are admitted. */
export async function withLocalTeam<T>(specialists: string[], maxTasks: number, work: (team: LocalTeam) => Promise<T>): Promise<T> {
  const names = ["buyer", "lead", ...specialists];
  if (new Set(names).size !== names.length || names.some(name => !/^[a-z]+$/.test(name)) ||
    !Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 201) throw new Error("invalid local team");
  useWebSocketImplementation(WebSocket);
  const keys = Object.fromEntries(names.map(name => [name, generateSecretKey()]));
  const roster = { buyer: getPublicKey(keys.buyer), lead: getPublicKey(keys.lead),
    ...Object.fromEntries(specialists.map(name => [name, getPublicKey(keys[name])])) };
  const team: LocalTeam = {
    roster, clients: {}, agents: {}, events: [], rootTaskId: null,
    async start() { for (const agent of Object.values(team.agents)) await agent.start(); },
  };
  const tasks = new Map<string, StoredEvent>();
  const started = performance.now();
  const participants = new Set(Object.values(roster));
  const specialistsByKey = new Set(specialists.map(name => team.roster[name]));
  let listening!: (port: number) => void;
  const ready = new Promise<number>(resolve => { listening = resolve; });
  const relay = startRelay({ port: 0, host: "127.0.0.1", onListening: listening, log: () => {}, policies: [{
    name: "local-coordination-team",
    onEvent(event) {
      const reject = { accept: false as const, reason: "blocked: outside local task chain" };
      if (!participants.has(event.pubkey)) return reject;
      if (event.kind === KIND_AGENT_METADATA) return { accept: true };
      const recipients = event.tags.filter(tag => tag[0] === "p");
      const parents = event.tags.filter(tag => tag[0] === "e");
      if (recipients.length !== 1 || parents.length > 1) return reject;
      const recipient = recipients[0][1];
      const parent = parents[0]?.[1];
      if (event.kind === KIND_AGENT_TASK) {
        if (tasks.size >= maxTasks) return reject;
        const root = event.pubkey === roster.buyer && recipient === roster.lead && parents.length === 0 && tasks.size === 0;
        const child = event.pubkey === roster.lead && specialistsByKey.has(recipient) && parent === team.rootTaskId;
        if (!root && !child) return reject;
        tasks.set(event.id, event);
        if (root) team.rootTaskId = event.id;
        return { accept: true };
      }
      const task = parent ? tasks.get(parent) : undefined;
      if (![KIND_AGENT_PROGRESS, KIND_AGENT_RESULT].includes(event.kind) || !task || task.pubkey !== recipient ||
        !task.tags.some(tag => tag[0] === "p" && tag[1] === event.pubkey)) return reject;
      return { accept: true };
    },
  }] });
  relay.onEvent(event => team.events.push({ receivedMs: Math.round(performance.now() - started), event: structuredClone(event) }));
  try {
    const url = `ws://127.0.0.1:${await ready}`;
    for (const name of names) {
      const privateKey = bytesToHex(keys[name]);
      if (name === "buyer" || name === "lead") {
        const client = new CapabilityClient({ relay: url, privateKey });
        team.clients[name] = client;
        await client.connect();
      }
      if (name !== "buyer") {
        team.agents[name] = await Agent.create({ relay: url, privateKey, name: `evaluation-${name}`, supportedTasks: ["evaluation"] });
      }
    }
    return await work(team);
  } finally {
    for (const client of Object.values(team.clients)) client.disconnect();
    for (const agent of Object.values(team.agents)) agent.stop();
    relay.close();
  }
}
