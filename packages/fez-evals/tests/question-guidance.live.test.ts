import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { findHarness, registerBuiltinHarnesses } from "../../../src/agent/harness.js";
import type { InputForm } from "../../fez-client/src/agent-input.js";

// Opt in with FEZ_LIVE_QUESTION_EVAL=1: this exercises the installed Claude
// adapter and real model, without sending messages or using a Fez identity.
it.skipIf(process.env.FEZ_LIVE_QUESTION_EVAL !== "1").each(["accept", "decline"] as const)(
  "uses the question UI after earlier unanswered requests (%s)", async action => {
    registerBuiltinHarnesses();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "fez-question-guidance-"));
    const forms: InputForm[] = [];
    const session = await findHarness("claude-code")!.openSession!(cwd, [], { idleMs: 60_000, maxMs: 90_000 },
      "You are @quill, a precise, warm writer. Help with drafts, edits, summaries, and making hard things land clearly and kindly.",
      async form => {
        forms.push(form);
        return action === "decline" ? { action } : { action, content: Object.fromEntries(
          form.fields.filter(field => field.options).map(field => [field.id, field.options![0].value]),
        ) };
      });
    try {
      const reply = await session.prompt([
        "You are @quill, in a PRIVATE direct-message conversation. This session is ONGOING — later messages arrive as new turns in the same conversation. Reply to them directly. If a task needs a tool or data source you don't have, say so plainly instead of improvising.",
        "Conversation so far:",
        "User: Ask me two multiple-choice questions before proceeding",
        "Assistant: Questions are up but unanswered — pick either option (or just tell me in your own words) and I'll start.",
        "User: Ask me two multiple-choice questions before proceeding",
        "Assistant: Both questions are waiting — what to work on, and how long. Pick one from each, or just say it plainly and I'll go.",
        "User: Ask me two multiple-choice questions before proceeding",
        "Reply to the last message. Be concise — this is chat.",
      ].join("\n\n"));
      expect(forms, reply).toHaveLength(1);
      expect(forms[0].fields.filter(field => field.options?.length)).toHaveLength(2);
      if (action === "decline") expect(reply).not.toMatch(/(?:questions|choices) (?:(?:are|remain) )?(?:still )?(?:up|waiting)|pick (?:one|either) (?:option|from)|(?:^|\n)\s*(?:[-*]|\d+[.)])\s/im);
    } finally {
      await session.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 100_000,
);
