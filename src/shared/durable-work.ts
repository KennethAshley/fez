import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools/pure";

export function workDirectory(pubkey: string, relays: string[]): string {
  const scope = createHash("sha256").update(JSON.stringify([pubkey, [...new Set(relays)].sort()])).digest("hex");
  return path.join(os.homedir(), ".fez", "agents", "inbox", scope);
}

function signed(value: unknown): Event {
  // Strip nostr-tools' cached verification symbol before crossing the disk boundary.
  const event = JSON.parse(JSON.stringify(value));
  if (!verifyEvent(event)) throw new Error("Invalid signed inbox event");
  return event;
}

function atomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

type Item = { event: Event; state: "queued" | "running" | "finished"; attempts: number; notBefore: number };
type Inbox = { version: 1; cursors: Record<string, number>; items: Record<string, Item> };

/** Single runtime writer; outgoing deliveries use separate files shared with MCP.
 * Keep finished IDs so replay cannot rerun work. Archive only with a matching
 * relay retention/checkpoint policy; age alone isn't proof an event cannot recur. */
export class DurableWork {
  private data: Inbox = { version: 1, cursors: {}, items: {} };
  private file: string;
  constructor(readonly directory: string) {
    this.file = path.join(directory, "inbox.json");
    if (fs.existsSync(this.file)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (data.version !== 1 || !data.items || !data.cursors) throw new Error("unsupported format");
        for (const [id, raw] of Object.entries(data.items)) {
          const item = raw as Item;
          if (signed(item.event).id !== id || !["queued", "running", "finished"].includes(item.state) ||
              !Number.isFinite(item.attempts) || !Number.isFinite(item.notBefore)) throw new Error("invalid item");
        }
        if (Object.values(data.cursors).some(time => typeof time !== "number" || !Number.isFinite(time))) throw new Error("invalid cursor");
        this.data = data;
      } catch (error) { throw new Error(`Cannot recover inbox ${this.file}: ${String(error)}`, { cause: error }); }
    }
  }
  private save(next: Inbox): void { atomic(this.file, next); this.data = next; }
  get(id: string): Item | undefined { return this.data.items[id]; }
  resultOwner(request: string, worker: string): string | undefined {
    return Object.values(this.data.items).find(item => item.event.pubkey === worker &&
      item.event.tags.some(tag => tag[0] === "result" && tag[1] === request))?.event.id;
  }
  pending(): Item[] { return Object.values(this.data.items).filter(item => item.state !== "finished"); }
  accept(value: unknown): boolean {
    const event = signed(value);
    if (this.get(event.id)) return false;
    this.save({ ...this.data, items: { ...this.data.items, [event.id]: { event, state: "queued", attempts: 0, notBefore: 0 } } });
    return true;
  }
  private update(id: string, patch: Partial<Omit<Item, "event">>): void {
    const item = this.get(id);
    if (!item) throw new Error(`Unknown inbox item ${id}`);
    this.save({ ...this.data, items: { ...this.data.items, [id]: { ...item, ...patch } } });
  }
  running(id: string): void { this.update(id, { state: "running" }); }
  queued(id: string, attempts = 0, notBefore = 0): void { this.update(id, { state: "queued", attempts, notBefore }); }
  finish(id: string): void { this.update(id, { state: "finished" }); }
  cursor(channel: string, initial: number): number {
    if (this.data.cursors[channel] === undefined) this.checkpoint(channel, initial);
    return this.data.cursors[channel];
  }
  checkpoint(channel: string, time: number): void {
    this.save({ ...this.data, cursors: { ...this.data.cursors, [channel]: time } });
  }
  /** First signed reply wins even across simultaneous MCP sessions. */
  delivery(id: string, create: () => Event): Event;
  delivery(id: string): Event | undefined;
  delivery(id: string, create?: () => Event): Event | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid delivery id");
    const file = path.join(this.directory, "outbox", `${id}.json`);
    if (fs.existsSync(file)) return signed(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!create) return;
    const event = signed(create());
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      atomic(tmp, event);
      try { fs.linkSync(tmp, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const dir = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return signed(JSON.parse(fs.readFileSync(file, "utf8")));
  }
}
