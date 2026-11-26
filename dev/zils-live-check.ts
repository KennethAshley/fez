// One real room decision and one real routing pick against Zils.
// Usage: bun --env-file=$HOME/.fez/zils.env dev/zils-live-check.ts
import { askJudge, chooseRoute, ZILS_URL } from "../packages/fez-orchestrator/src/judge.js";

const key = process.env.ZILS_API_KEY ?? "";
const thread = [
  { from: "ken", text: "@drift find the latest Deno release and what changed" },
  { from: "drift", text: "Deno 2.5 shipped last week: permission sets in config, a bundle command, and faster startup." },
];
let started = Date.now();
const judged = await askJudge(ZILS_URL, key, { thread }, {
  addressed: { type: "noul", instructions: { agent: "quill", question: "Does the latest message in `thread` ask `agent` to do, answer, or produce something?" } },
  done: { type: "noul", instructions: "Is the task or question in `thread` complete or decided, with no further agent action needed?" },
  outcome: { type: "choice", instructions: "How does the last message respond to what the first asked for?",
    criteria: { answered: "gives the requested facts", partial: "a requested point is missing", deferred: "asks a question back or reports a blocker" } },
});
console.log("judge", Date.now() - started, "ms", judged.model, JSON.stringify(judged.answers));
started = Date.now();
const route = await chooseRoute(key, "write a short announcement post for our new release", {
  drift: "searches the web and reads pages", quill: "writes and edits prose", forge: "writes and reviews code", nobody: "no agent fits",
}, { baseUrl: ZILS_URL });
console.log("route", Date.now() - started, "ms", route.choice, route.confidence.toFixed(2), JSON.stringify(route.probabilities));
