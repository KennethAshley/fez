import fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { StoredEvent } from "./relay.js";

/**
 * EventStore — the relay's bring-your-own durability seam. The relay
 * keeps its query index in memory (load() hydrates it at startup) and
 * calls append() for every accepted non-ephemeral event. Implement these
 * two methods over any backend — the operator's storage and its security
 * are their concern, not fez's. Shipped implementations: JSONL (zero
 * setup, the default) and SQLite (single-file durability, node:sqlite,
 * zero dependencies). See examples/operator-supabase for a
 * Postgres/Supabase reference.
 */
export interface EventStore {
  load(): StoredEvent[];
  append(event: StoredEvent): void;
}

export class JsonlEventStore implements EventStore {
  constructor(private file: string) {}

  load(): StoredEvent[] {
    try {
      return fs
        .readFileSync(this.file, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  append(event: StoredEvent): void {
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
  }
}

export class SqliteEventStore implements EventStore {
  private db: DatabaseSync;
  private insert;

  constructor(file: string) {
    // Lazy-loaded at construction: node:sqlite is a prefix-only builtin
    // that bundlers (vite/vitest) mis-resolve at module scope, and a JSONL
    // operator shouldn't pay for (or need Node support for) sqlite at all.
    const { DatabaseSync: Db } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: typeof DatabaseSync;
    };
    this.db = new Db(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        kind INTEGER NOT NULL,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        sig TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_kind ON events (kind);
      CREATE INDEX IF NOT EXISTS events_pubkey ON events (pubkey);
    `);
    this.insert = this.db.prepare(
      "INSERT OR IGNORE INTO events (id, kind, pubkey, created_at, content, tags, sig) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
  }

  load(): StoredEvent[] {
    return (this.db.prepare("SELECT * FROM events ORDER BY created_at").all() as Record<string, unknown>[]).map(
      (row) => ({
        id: row.id as string,
        kind: row.kind as number,
        pubkey: row.pubkey as string,
        created_at: row.created_at as number,
        content: row.content as string,
        tags: JSON.parse(row.tags as string),
        sig: row.sig as string,
      })
    );
  }

  append(event: StoredEvent): void {
    this.insert.run(
      event.id,
      event.kind,
      event.pubkey,
      event.created_at,
      event.content,
      JSON.stringify(event.tags),
      event.sig
    );
  }
}

/** Pick a store from a --store path: .db/.sqlite/.sqlite3 → SQLite, anything else → JSONL. */
export function storeForPath(file: string): EventStore {
  return /\.(db|sqlite3?)$/i.test(file) ? new SqliteEventStore(file) : new JsonlEventStore(file);
}
