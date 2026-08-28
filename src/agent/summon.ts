/**
 * Summon policy shared by every summoning host (sentinel, desktop).
 * Extracted from fez-sentinel so the GUI can summon while open without
 * the daemon — one policy, two hosts, no drift.
 */

import { MAX_CHAIN_DEPTH } from "../protocol/limits.js";

/**
 * A string safe to interpolate into a SHELL COMMAND — the repo/line an
 * agent is summoned onto reach a live terminal via herdr, so they are
 * validated like git validates refs: letters, digits, dot, dash, slash,
 * underscore, no `..`, bounded length. Not escaped — REFUSED. Exported
 * so the source (work-context resolution) and the sinks (herdr command
 * line, the desktop's Rust spawn) share ONE definition of "safe".
 */
export function isSafeWork(value: string | undefined): boolean {
  return !!value && /^[\w][\w./-]{0,200}$/.test(value) && !value.includes("..");
}

/**
 * Mention ≠ summon. An @name in PROSE is a call; one inside a code fence,
 * inline backticks, or quotes is speech ABOUT an agent (example text, tool
 * source, a quoted message) and must not spawn it. Unbalanced delimiters
 * fail open — a spare summon is harmless (the agent reads the thread and
 * stands down), a silently dropped one is a no-show.
 */
export function summonMentions(content: string): string[] {
  const prose = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ");
  return [...new Set([...prose.matchAll(/@([\w-]+)/g)].map((m) => m[1].toLowerCase()))];
}
export interface SummonEvent {
  id?: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  created_at?: number;
}
export interface WorkContext { repo: string; line?: string }
export interface RegistryEntry { channels: string[]; work?: WorkContext }

export interface SummonHost {
  ownerPubkey: string;
  personaExists(name: string): boolean | Promise<boolean>;
  personaPubkey(name: string): Promise<string | undefined>;
  agentAlive(name: string): boolean | Promise<boolean>;
  registryEntry(name: string): RegistryEntry | undefined | Promise<RegistryEntry | undefined>;
  spawn(persona: string, channels: string[], work?: WorkContext): Promise<void>;
  /** Kill the running instance, then spawn with these channels/work. */
  restart(persona: string, channels: string[], work?: WorkContext): Promise<void>;
  query(filters: object[]): Promise<SummonEvent[]>;
  /** Publish signed AS THE OWNER — attestations, roster updates. */
  publish(template: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<void>;
  /** Watchdog surface: persona never announced within watchdogMs. */
  announceTimeout(persona: string, channelId: string): void;
  log?(line: string): void;
}

const KIND_METADATA = 47000;
const KIND_ATTESTATION = 47006;
const KIND_MESSAGE = 47103;
const KIND_DOC_COMMENT = 40101;
const KIND_MEMBERSHIP = 47102;
const ROSTER_D = "roster";

const safeWork = (value: string | undefined): string | undefined =>
  isSafeWork(value) ? value : undefined;

export class SummonEngine {
  private readonly cooldownMs: number;
  private readonly maxChainDepth: number;
  private readonly watchdogMs: number;
  private readonly agentPkToName = new Map<string, string>();
  private readonly attestedSiblings = new Set<string>();
  private readonly attested = new Set<string>();
  private readonly spawning = new Set<string>();
  private readonly pendingInvites = new Map<string, { channelId: string }>();
  private readonly lastSummonAt = new Map<string, number>();

  constructor(
    private readonly host: SummonHost,
    opts?: { cooldownMs?: number; maxChainDepth?: number; watchdogMs?: number }
  ) {
    this.cooldownMs = opts?.cooldownMs ?? 15_000;
    this.maxChainDepth = opts?.maxChainDepth ?? MAX_CHAIN_DEPTH;
    this.watchdogMs = opts?.watchdogMs ?? 90_000;
  }

  private log(line: string): void {
    this.host.log?.(line);
  }

  noteAnnouncement(pubkey: string, name: string): void {
    this.agentPkToName.set(pubkey, name.toLowerCase());
  }

  noteAttestation(pubkey: string): void {
    this.attestedSiblings.add(pubkey);
  }

  nameOf(pk: string): string {
    return this.agentPkToName.get(pk) ?? `${pk.slice(0, 8)}…`;
  }

  /** Hydrate announced names + our own attestations (sentinel boot parity). */
  async seedRosters(): Promise<void> {
    const [metadataEvents, attestations] = await Promise.all([
      this.host.query([{ kinds: [KIND_METADATA], limit: 200 }]),
      this.host.query([{ kinds: [KIND_ATTESTATION], authors: [this.host.ownerPubkey] }]),
    ]);
    for (const event of metadataEvents) {
      try {
        const name = JSON.parse(event.content).name?.toLowerCase();
        if (name) this.agentPkToName.set(event.pubkey, name);
      } catch { /* ignore */ }
    }
    for (const event of attestations) {
      const pk = event.tags.find((t) => t[0] === "p")?.[1];
      if (pk) this.attestedSiblings.add(pk);
    }
  }

  async handleEvent(event: SummonEvent): Promise<void> {
    if (event.kind === KIND_METADATA) return this.handleAnnouncement(event);
    if (event.kind === KIND_DOC_COMMENT) return this.handleDocComment(event);
    if (event.kind === KIND_MESSAGE) return this.handleChannelMessage(event);
  }

  private authorized(pubkey: string): boolean {
    return pubkey === this.host.ownerPubkey || this.attestedSiblings.has(pubkey);
  }

  private async handleChannelMessage(event: SummonEvent): Promise<void> {
    if (!this.authorized(event.pubkey)) return;
    if (Number(event.tags.find((t) => t[0] === "depth")?.[1] ?? 0) >= this.maxChainDepth) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return;
    const work = await this.workContextOf(event, channelId);
    for (const persona of summonMentions(event.content)) {
      if (this.spawning.has(persona) || !(await this.host.personaExists(persona))) continue;
      // An agent mentioning ITSELF (its dying "failed to start" words, or
      // any self-reference) is not a summon — else a spawn-death loops.
      if ((await this.host.personaPubkey(persona)) === event.pubkey) continue;
      if (await this.host.agentAlive(persona)) {
        await this.maybeRestart(persona, channelId, work);
        continue;
      }
      this.pendingInvites.set(persona, { channelId });
      await this.summon(persona, [channelId], `mention by ${this.nameOf(event.pubkey)}`, work);
    }
  }

  private async summon(persona: string, channels: string[], why: string, work?: WorkContext): Promise<void> {
    const last = this.lastSummonAt.get(persona);
    if (last !== undefined && Date.now() - last < this.cooldownMs) {
      this.log(`⏳ summon for @${persona} suppressed — cooldown (${why})`);
      return;
    }
    this.lastSummonAt.set(persona, Date.now());
    this.spawning.add(persona);
    this.log(`✨ ${why} → summoning @${persona}${work ? ` onto ${work.repo}:${work.line}` : ""}`);
    try {
      await this.preInvite(persona);
      await this.host.spawn(persona, channels, work);
      this.armWatchdog(persona, channels[0]);
    } catch (err) {
      this.log(`⚠️  couldn't summon @${persona}: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.spawning.delete(persona);
    }
  }

  private armWatchdog(persona: string, channelId: string | undefined): void {
    if (!channelId) return;
    const timer = setTimeout(() => {
      void (async () => {
        if (!this.pendingInvites.has(persona) || (await this.host.agentAlive(persona))) return;
        this.pendingInvites.delete(persona);
        this.host.announceTimeout(persona, channelId);
      })();
    }, this.watchdogMs);
    (timer as { unref?: () => void }).unref?.();
  }

  private async handleAnnouncement(event: SummonEvent): Promise<void> {
    let name: string | undefined;
    try {
      name = JSON.parse(event.content).name?.toLowerCase();
    } catch { return; }
    if (!name) return;
    this.agentPkToName.set(event.pubkey, name);
    if (await this.host.registryEntry(name)) this.attestAgent(event.pubkey);
    const target = this.pendingInvites.get(name);
    if (target) {
      this.pendingInvites.delete(name);
      this.attestAgent(event.pubkey);
      try {
        await this.inviteToWorkspace(event.pubkey);
        this.log(`🤝 @${name} announced — invited to its channel`);
      } catch {
        this.log(`⚠️  invite for @${name} failed`);
      }
    }
  }

  private async handleDocComment(event: SummonEvent): Promise<void> {
    if (!this.authorized(event.pubkey)) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return;
    for (const persona of summonMentions(event.content)) {
      if (this.spawning.has(persona) || !(await this.host.personaExists(persona)) || (await this.host.agentAlive(persona))) continue;
      this.pendingInvites.set(persona, { channelId });
      await this.summon(persona, [channelId], `doc comment by ${this.nameOf(event.pubkey)}`);
    }
  }

  async handleGiftWrapRecipient(recipientPk: string): Promise<void> {
    const persona = this.agentPkToName.get(recipientPk);
    if (!persona) return;
    if (this.spawning.has(persona) || !(await this.host.personaExists(persona)) || (await this.host.agentAlive(persona))) return;
    const prior = await this.host.registryEntry(persona);
    await this.summon(persona, prior?.channels ?? [], "DM for a sleeping agent");
  }

  /** Running, but summoned into a channel it doesn't serve — or onto a
   * DIFFERENT line: one process per persona, one body per line, so a
   * line switch is a restart. */
  private async maybeRestart(persona: string, channelId: string, work?: WorkContext): Promise<void> {
    const entry = await this.host.registryEntry(persona);
    if (!entry) return;
    const needsChannel = !entry.channels.includes(channelId);
    const needsLine = work !== undefined && (entry.work?.repo !== work.repo || (work.line !== undefined && entry.work?.line !== work.line));
    if (!needsChannel && !needsLine) return;
    this.spawning.add(persona);
    this.pendingInvites.set(persona, { channelId });
    this.log(needsLine ? `🔁 moving @${persona} onto line ${work?.line} (restart)` : `🔁 pulling @${persona} into a new channel (restart with union)`);
    try {
      await this.host.restart(persona, needsChannel ? [...entry.channels, channelId] : entry.channels, work ?? entry.work);
    } finally {
      this.spawning.delete(persona);
    }
  }

  private attestAgent(agentPubkey: string): void {
    if (this.attested.has(agentPubkey) || agentPubkey === this.host.ownerPubkey) return;
    this.attested.add(agentPubkey);
    this.attestedSiblings.add(agentPubkey);
    void this.host
      .publish({ kind: KIND_ATTESTATION, tags: [["p", agentPubkey]], content: "" })
      .catch(() => this.attested.delete(agentPubkey));
  }

  private async inviteToWorkspace(agentPubkey: string): Promise<void> {
    const rosters = await this.host.query([{ kinds: [KIND_MEMBERSHIP], "#d": [ROSTER_D] }]);
    const latest = rosters.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0)).at(-1);
    // No roster seen means the QUERY failed, not that the workspace has no
    // members — BrowserWire.query resolves [] whenever no socket is OPEN. A
    // 47102 built from that blip would hold only the new agent and, being
    // newer, would replace the real roster on the relay: the owner-less wipe
    // FezClient.publishRoster guards against at its own write site. Refuse;
    // the next summon retries against a live socket.
    if (!latest) throw new Error("roster query returned nothing — refusing a write that would wipe the members");
    const ptags = latest.tags.filter((t) => t[0] === "p");
    if (ptags.some((t) => t[1] === agentPubkey)) return;
    ptags.push(["p", agentPubkey, "bot"]);
    // Same rule as publishRoster: the owner is ALWAYS on their own roster,
    // whatever the stored event says.
    if (!ptags.some((t) => t[1] === this.host.ownerPubkey)) ptags.unshift(["p", this.host.ownerPubkey, "owner"]);
    await this.host.publish({
      kind: KIND_MEMBERSHIP,
      tags: [["d", ROSTER_D], ...ptags],
      content: "",
      created_at: Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1),
    });
  }

  /** Roster the persona BEFORE its process exists (sentinel's preInvite —
   * a repo agent's first act is cloning and the clone is roster-gated). */
  private async preInvite(persona: string): Promise<void> {
    try {
      const pk = await this.host.personaPubkey(persona);
      if (!pk) return;
      await this.inviteToWorkspace(pk);
      this.attestAgent(pk);
    } catch (err) {
      this.log(`⚠️  pre-invite for @${persona} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async workContextOf(event: SummonEvent, channelId: string): Promise<WorkContext | undefined> {
    try {
      const chans = await this.host.query([{ kinds: [47101], "#d": [channelId], authors: [this.host.ownerPubkey] }]);
      const latest = chans.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
      if (!latest) return undefined;
      const parsed = JSON.parse(latest.content) as { source?: string; meta?: { repo?: string } };
      if (parsed.source !== "fez-git") return undefined;
      const repo = safeWork(parsed.meta?.repo);
      if (!repo) return undefined;
      const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
      const rootId = (eTags.find((t) => t[3] === "root") ?? eTags[0])?.[1];
      if (!rootId) return { repo };
      const [root] = await this.host.query([{ ids: [rootId] }]);
      const marker = root?.content?.match(/^⑂ `([^`]+)`/);
      if (!marker) return { repo };
      const branch = marker[1];
      const line = safeWork(branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch);
      return line ? { repo, line } : { repo };
    } catch {
      return undefined;
    }
  }
}
