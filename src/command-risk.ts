/**
 * Command risk classification — pure, eval-pinned.
 *
 * Fez's approval gate used to be an honor system: an agent was TOLD to
 * call fez_request_approval before anything destructive, and a confused
 * or adversarial agent simply doesn't. Meanwhile the ACP layer
 * auto-approved every tool call the harness asked about, because the
 * user was assumed to be sitting right there — untrue the moment an
 * agent runs unattended in a channel.
 *
 * This module turns the convention into a control: classify what the
 * harness is about to run, and let the host decide (auto-allow, ask the
 * owner, refuse) from the classification rather than from the agent's
 * self-assessment.
 *
 * Deliberate posture:
 * - Pattern matching over a shell string is a HEURISTIC, not a sandbox.
 *   It raises the cost of an accident and catches the obvious cases; it
 *   is not a security boundary against a determined adversary (`eval`,
 *   base64, an aliased binary, a script file all evade it). Anything
 *   that must not happen needs OS-level containment, not this.
 * - When unsure, escalate rather than allow. A spurious approval prompt
 *   is an annoyance; a silent `rm -rf` is unrecoverable.
 */

export type RiskLevel = "safe" | "caution" | "dangerous";

export interface RiskVerdict {
  level: RiskLevel;
  /** Short human sentence — this is what the owner reads in the approval card. */
  reason: string;
  /** The rule that fired, for debugging and for the audit trail. */
  rule?: string;
}

interface Rule {
  id: string;
  pattern: RegExp;
  level: RiskLevel;
  reason: string;
}

/**
 * Ordered: the FIRST match wins, so put specific carve-outs above the
 * broad rule they qualify.
 */
const RULES: Rule[] = [
  // ── destructive filesystem ──────────────────────────────────────────
  {
    id: "rm-recursive-root",
    pattern: /\brm\s+(-[a-z]*\s+)*-?[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\/\*|\.\s*$|\*)/i,
    level: "dangerous",
    reason: "recursive delete of a root, home, or wildcard path",
  },
  { id: "rm-recursive", pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r/i, level: "dangerous", reason: "recursive file deletion" },
  { id: "mkfs", pattern: /\bmkfs(\.\w+)?\b|\bdiskutil\s+erase|\bformat\s+[a-z]:/i, level: "dangerous", reason: "formats a filesystem" },
  { id: "dd-device", pattern: /\bdd\b[^|]*\bof=\/dev\//i, level: "dangerous", reason: "writes directly to a device" },
  { id: "shred", pattern: /\bshred\b|\bsrm\b/i, level: "dangerous", reason: "irrecoverable file destruction" },

  // ── history rewrite / unrecoverable VCS ─────────────────────────────
  { id: "git-force-push", pattern: /\bgit\s+push\b[^|;]*(--force\b|--force-with-lease\b|\s-f\b)/i, level: "dangerous", reason: "force-push rewrites shared history" },
  { id: "git-hard-reset", pattern: /\bgit\s+reset\s+(--hard|--merge)\b/i, level: "dangerous", reason: "discards uncommitted work" },
  { id: "git-clean", pattern: /\bgit\s+clean\b[^|;]*-[a-z]*[fx]/i, level: "dangerous", reason: "deletes untracked files" },
  { id: "git-branch-delete", pattern: /\bgit\s+branch\s+-D\b/i, level: "caution", reason: "force-deletes a branch" },

  // ── publishing / spending / outward-facing ──────────────────────────
  { id: "npm-publish", pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, level: "dangerous", reason: "publishes a package publicly" },
  { id: "deploy", pattern: /\b(vercel|netlify|fly|heroku|wrangler)\s+deploy\b|\bkubectl\s+(apply|delete)\b|\bterraform\s+(apply|destroy)\b|\bserverless\s+deploy\b/i, level: "dangerous", reason: "deploys to a live environment" },
  { id: "aws-destroy", pattern: /\baws\s+\w+\s+(delete|terminate|remove)-/i, level: "dangerous", reason: "destroys cloud infrastructure" },
  { id: "gh-release", pattern: /\bgh\s+release\s+(create|delete)\b|\bgh\s+repo\s+delete\b/i, level: "dangerous", reason: "changes a public repository" },

  // ── database ────────────────────────────────────────────────────────
  { id: "sql-drop", pattern: /\b(drop\s+(database|table|schema)|truncate\s+table)\b/i, level: "dangerous", reason: "destroys database data" },
  { id: "sql-delete-unbounded", pattern: /\bdelete\s+from\s+\w+\s*(;|$)/i, level: "dangerous", reason: "unbounded DELETE — no WHERE clause" },

  // ── credentials & privilege ─────────────────────────────────────────
  { id: "sudo", pattern: /(^|[\s;|&])sudo\s|(^|[\s;|&])doas\s/i, level: "dangerous", reason: "runs with elevated privileges" },
  { id: "chmod-world", pattern: /\bchmod\s+(-[a-z]+\s+)*777\b|\bchmod\s+(-[a-z]+\s+)*a\+rwx/i, level: "caution", reason: "makes files world-writable" },
  { id: "keychain-dump", pattern: /\bsecurity\s+(dump-keychain|find-generic-password)\b|\bcat\s+[^|;]*\.(ssh\/id_|aws\/credentials|env\b)/i, level: "dangerous", reason: "reads stored secrets" },
  { id: "ssh-remote", pattern: /(^|[\s;|&])ssh\s+[\w.@-]+\s+["']?[a-z]/i, level: "caution", reason: "runs a command on a remote host" },

  // ── remote code execution ───────────────────────────────────────────
  { id: "curl-pipe-shell", pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/i, level: "dangerous", reason: "pipes downloaded code straight into a shell" },
  { id: "eval-remote", pattern: /\beval\s+["'$(]*\s*\$\(\s*(curl|wget)/i, level: "dangerous", reason: "evaluates downloaded code" },

  // ── process control ─────────────────────────────────────────────────
  { id: "kill-broad", pattern: /\b(killall|pkill)\s+(-9\s+)?(node|python|-f\s+["']?\*)/i, level: "caution", reason: "kills processes broadly" },
  { id: "shutdown", pattern: /\b(shutdown|reboot|halt)\b/i, level: "dangerous", reason: "restarts or powers off the machine" },

  // ── writes that are ordinary but not read-only ──────────────────────
  { id: "package-install", pattern: /\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b/i, level: "caution", reason: "installs dependencies" },
  { id: "git-push", pattern: /\bgit\s+push\b/i, level: "caution", reason: "pushes commits to a remote" },
  { id: "git-commit", pattern: /\bgit\s+(commit|merge|rebase)\b/i, level: "caution", reason: "changes repository history" },
];

/** Commands that only READ — the overwhelming majority of agent tool calls. */
const READ_ONLY = /^\s*(ls|cat|head|tail|wc|grep|rg|fd|find|which|type|echo|pwd|whoami|date|env|printenv|stat|file|du|df|tree|jq|sort|uniq|cut|awk|sed\s+-n|diff|git\s+(status|log|diff|show|branch\b(?!\s+-D)|remote|rev-parse|config\s+--get)|npm\s+(ls|view|run\s+(test|check|lint|build))|node\s+-e|curl\s+-s?I?\s)/i;

/**
 * Classify a shell command (or a tool-call description). Returns the
 * HIGHEST risk found — a compound command is as dangerous as its worst
 * part, since `cd x && rm -rf /` is one string to the shell.
 */
export function classifyCommand(command: string): RiskVerdict {
  const text = (command ?? "").trim();
  if (!text) return { level: "safe", reason: "empty command" };

  let worst: RiskVerdict = { level: "safe", reason: "no risky pattern matched" };
  const order: Record<RiskLevel, number> = { safe: 0, caution: 1, dangerous: 2 };
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    if (order[rule.level] > order[worst.level]) {
      worst = { level: rule.level, reason: rule.reason, rule: rule.id };
      if (worst.level === "dangerous") return worst; // can't get worse
    }
  }
  if (worst.level === "safe" && READ_ONLY.test(text)) {
    return { level: "safe", reason: "read-only command", rule: "read-only" };
  }
  return worst;
}

/**
 * Pull the thing to classify out of an ACP permission request. Harnesses
 * describe a tool call with a title plus raw input; shell tools carry the
 * command, file tools carry a path. We classify the command when there is
 * one, and fall back to the title so an unknown tool still gets looked at.
 */
export function classifyToolCall(toolCall: {
  title?: string;
  kind?: string;
  rawInput?: unknown;
}): RiskVerdict {
  const raw = (toolCall.rawInput ?? {}) as Record<string, unknown>;
  const command =
    typeof raw.command === "string"
      ? raw.command
      : Array.isArray(raw.command)
        ? raw.command.join(" ")
        : typeof raw.cmd === "string"
          ? raw.cmd
          : undefined;
  if (command) return classifyCommand(command);

  // Non-shell tools: writing/editing files is ordinary agent work
  // (caution), everything else falls through to the title text.
  if (toolCall.kind === "edit" || toolCall.kind === "write") {
    return { level: "caution", reason: "edits files", rule: "tool-kind-edit" };
  }
  if (toolCall.kind === "read" || toolCall.kind === "search" || toolCall.kind === "fetch") {
    return { level: "safe", reason: "read-only tool", rule: "tool-kind-read" };
  }
  return classifyCommand(toolCall.title ?? "");
}
