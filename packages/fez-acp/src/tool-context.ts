import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Turn = { id: string; order: string[]; state: 'running' | 'done' };

/** Private runtime facts for local tool hosts. No prompts, credentials or model-authored state. */
export class ToolContext {
  private readonly file: string;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private turn: Turn | null = null;
  private closed = false;
  constructor(home: string, private readonly persona: string, private readonly tools: string[]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(persona)) throw new Error('Invalid tool context persona');
    const directory = join(home, '.fez', 'agent-runtime');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, `${persona}.json`);
    this.write();
    this.heartbeat = setInterval(() => this.write(), 3000);
    this.heartbeat.unref();
  }
  private write() {
    if (this.closed) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, persona: this.persona, pid: process.pid,
      tools: this.tools, updatedAt: Date.now(), turn: this.turn }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  async run<T>(turn: { id: string; order: string[] } | undefined, work: () => Promise<T>): Promise<T> {
    this.turn = turn ? { ...turn, state: 'running' } : null;
    this.write();
    try { return await work(); }
    finally { if (this.turn) this.turn.state = 'done'; this.write(); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    try { if (JSON.parse(readFileSync(this.file, 'utf8')).pid === process.pid) unlinkSync(this.file); }
    catch { /* already removed or replaced by a newer runtime */ }
  }
}
