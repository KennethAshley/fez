/**
 * Extension-registered slash commands — e.g. a communities extension
 * registering `/join`, `/community`, matching pi-atelier's `/atelier`
 * pattern of an extension owning its own control surface instead of
 * tui.ts's built-in switch statement growing a case per extension.
 *
 * Same registry pattern as harness.ts/mcp-servers.ts: one entry point,
 * warn-and-skip on a duplicate name. Only consulted for commands Fez's
 * own built-ins (/quit, /help, ...) don't already handle — see
 * handleCommand()'s default case in tui.ts. Built-ins aren't routed
 * through this registry; they're not up for override.
 */
export interface CommandContext {
  /** Print a message into the chat, as if the orchestrator said it. */
  reply(content: string): void;
}

export type CommandHandler = (args: string, ctx: CommandContext) => void | Promise<void>;

const registry = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  if (registry.has(name)) {
    console.error(`⚠️  Command "/${name}" is already registered — skipping duplicate`);
    return;
  }
  registry.set(name, handler);
}

export function findCommand(name: string): CommandHandler | undefined {
  return registry.get(name);
}

export function listCommands(): string[] {
  return [...registry.keys()];
}
