import { parseThreadRef } from "./thread-ref.js";

type WorkEvent = { id: string; pubkey: string; content: string; tags: string[][] };
const one = (e: WorkEvent, tag: string) => {
  const values = e.tags.filter(t => t[0] === tag);
  return values.length === 1 ? values[0]?.[1] : undefined;
};
const root = (e: WorkEvent) => parseThreadRef(e.tags).rootId ?? e.id;

/** An external caller owns result handling instead of a standing agent's callback. */
export function externalResultHandler(event: Pick<WorkEvent, "tags">): boolean {
  return event.tags.some(t => t[0] === "result-handler" && t[1] === "external");
}

/** Call only on signature-verified channel messages. A reply p-tag alone
 * is not an assignment: only the request's explicit task tags grant it. */
export function workResult(event: WorkEvent, request: WorkEvent): "success" | "error" | undefined {
  const status = one(event, "status");
  if ((status !== "success" && status !== "error") || !event.content.trim()) return;
  if (one(event, "result") !== request.id || !one(request, "h") || one(event, "h") !== one(request, "h")) return;
  if (root(event) !== root(request) || parseThreadRef(event.tags).parentId !== request.id) return;
  if (!event.tags.some(t => t[0] === "p" && t[1] === request.pubkey)) return;
  if (request.pubkey === event.pubkey || !request.tags.some(t => t[0] === "task" && t[1] === event.pubkey)) return;
  return status;
}

/** The signed request is authoritative, including for older workers that
 * do not copy its handler marker into their result. */
export function workResultForAgent(event: WorkEvent, request: WorkEvent): "success" | "error" | undefined {
  if (!externalResultHandler(request)) return workResult(event, request);
}

export function completeWork(request: WorkEvent, worker: string, opts: {
  status: "success" | "error"; summary: string; capability: string; artifacts: string[];
}) {
  if (!one(request, "h") || request.pubkey === worker || !request.tags.some(t => t[0] === "task" && t[1] === worker)) {
    throw new Error("This message did not assign work to you.");
  }
  if (!["success", "error"].includes(opts.status) || !opts.summary.trim() || opts.summary.length > 8000 ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(opts.capability) || opts.artifacts.length > 16 ||
      opts.artifacts.some(a => !/^https:\/\/\S{1,2048}$/.test(a) && !/^[a-f0-9]{64}$/.test(a))) {
    throw new Error("Invalid result: supply a summary, capability, and HTTPS artifact URLs or event ids.");
  }
  return { kind: 47103, content: opts.summary, tags: [
    ["h", one(request, "h")!], ["e", root(request), "", "root"], ["e", request.id, "", "reply"],
    ["p", request.pubkey], ["result", request.id], ["status", opts.status], ["capability", opts.capability],
    ["depth", String(Number(request.tags.find(t => t[0] === "depth")?.[1] ?? 0) + 1)],
    ...(externalResultHandler(request) ? [["result-handler", "external"]] : []),
    ...opts.artifacts.map(a => ["artifact", a]),
  ] };
}

/** Acceptance belongs to the requester, never to the worker. A chit
 * records that requester's judgment; it is not independent quality proof. */
export function acceptWork(result: WorkEvent, request: WorkEvent, issuer: string, note: string) {
  if (request.pubkey !== issuer || workResult(result, request) !== "success") {
    throw new Error("Only the requester can accept a successful result from the assigned worker.");
  }
  if (!note.trim() || note.length > 2000) throw new Error("Explain what you checked before accepting (1–2000 characters).");
  const capability = one(result, "capability");
  return { kind: 47007, content: note, tags: [
    ["p", result.pubkey], ["e", result.id], ["h", one(request, "h")!], ["task", request.id],
    ...(capability ? [["capability", capability]] : []),
  ] };
}
