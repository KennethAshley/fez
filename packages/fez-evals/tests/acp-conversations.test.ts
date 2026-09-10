import { afterEach, describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { startAcpRuntime, TEST_CHANNEL, OTHER_CHANNEL } from "./helpers/acp-runtime.js";

let runtime: Awaited<ReturnType<typeof startAcpRuntime>> | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });

describe("ACP conversation routing through the real runtime", () => {
  test("a busy page preserves the exact thread context and complete long selection", async () => {
    const r = runtime = await startAcpRuntime();
    const selection = { text: "Selected paragraph. ".repeat(30) + "FINAL_SELECTED_SENTENCE", prefix: "UNIQUE_PREFIX", suffix: "UNIQUE_SUFFIX" };
    const root = await r.send("Original decision in this thread", [["h", TEST_CHANNEL], ["d", "busy-page"], ["anchor", selection.text.slice(0, 300)], ["anchor-context", JSON.stringify(selection)]], 40101);
    await r.send("Prior feedback in this thread", [["h", TEST_CHANNEL], ["d", "busy-page"], ["e", root.id]], 40101);
    for (let i = 0; i < 501; i++) r.relay.events.push(r.owner.signEvent({ kind: 40101, created_at: root.created_at + 1,
      tags: [["h", TEST_CHANNEL], ["d", "busy-page"]], content: `Other discussion ${i}` }));
    await r.send("Rewrite the selected passage using our discussion.", [["h", TEST_CHANNEL], ["d", "busy-page"], ["e", root.id], ["p", r.agentPk], ["writer", r.agentPk]], 40101);
    await r.wait(() => r.prompts.length === 1, "older document thread");
    const instruction = r.prompts[0].instruction;
    expect(instruction).toContain("Original decision in this thread");
    expect(instruction).toContain("Prior feedback in this thread");
    expect(instruction).toContain("FINAL_SELECTED_SENTENCE");
    expect(instruction).toContain("UNIQUE_PREFIX");
    expect(instruction).toContain("UNIQUE_SUFFIX");
    expect(instruction).not.toContain("Other discussion");
    r.release(r.prompts[0]);
  }, 30_000);
  test.each([true, false])("document conversation includes prior feedback and the per-turn writer (writer: %s)", async (isWriter) => {
    const r = runtime = await startAcpRuntime();
    const inheritedWriter = isWriter ? r.owner.getPubkey() : r.agentPk;
    const root = await r.send("Earlier decision: keep unrequested ideas as suggestions.", [["h", TEST_CHANNEL], ["d", "writing-page"], ["anchor", "Agents may edit."], ["writer", inheritedWriter]], 40101);
    await r.send("Prior reviewer: preserve the original wording for undo.", [["h", TEST_CHANNEL], ["d", "writing-page"], ["e", root.id]], 40101);
    await r.send("Unrelated feedback must stay elsewhere.", [["h", TEST_CHANNEL], ["d", "other-page"], ["e", root.id]], 40101);
    const strangerKey = generateSecretKey();
    await r.publish(finalizeEvent({ kind: 40101, created_at: Math.floor(Date.now() / 1000),
      tags: [["h", TEST_CHANNEL], ["d", "writing-page"], ["e", root.id]], content: "Non-member feedback must not enter the prompt." }, strangerKey));
    const writer = isWriter ? r.agentPk : r.owner.getPubkey();
    await r.send("Does this agreement make sense?", [["h", TEST_CHANNEL], ["d", "writing-page"], ["e", root.id], ["p", r.agentPk], ["writer", writer]], 40101);
    await r.wait(() => r.prompts.length === 1, "native document question");
    expect(r.prompts[0].instruction).toContain("Earlier decision: keep unrequested ideas as suggestions.");
    expect(r.prompts[0].instruction).toContain("Prior reviewer: preserve the original wording for undo.");
    expect(r.prompts[0].instruction).not.toContain("Unrelated feedback must stay elsewhere.");
    expect(r.prompts[0].instruction).not.toContain("Non-member feedback must not enter the prompt.");
    expect(r.prompts[0].instruction).toContain(isWriter ? "You are the designated writer" : "You are a reviewer for this request");
    expect(r.prompts[0].instruction).toContain("Questions and requests for feedback do not authorize document edits");
    expect(r.prompts[0].instruction).toContain("baseId");
    r.release(r.prompts[0], "Document discussion answer");
    await r.wait(() => r.relay.events.some(e => e.content === "Document discussion answer"), "document response");
    const reply = r.relay.events.find(e => e.content === "Document discussion answer")!;
    expect(reply.kind).toBe(40101);
    expect(reply.tags).toContainEqual(["e", root.id]);
    expect(reply.tags).toContainEqual(["writer", writer]);
  }, 30_000);

  test("an invalid current writer does not inherit the root writer or authorize editing", async () => {
    const r = runtime = await startAcpRuntime();
    const root = await r.send("Root request", [["h", TEST_CHANNEL], ["d", "writing-page"], ["writer", r.agentPk]], 40101);
    await r.send("Please review this.", [["h", TEST_CHANNEL], ["d", "writing-page"], ["e", root.id], ["p", r.agentPk], ["writer", "not-a-pubkey"]], 40101);
    await r.wait(() => r.prompts.length === 1, "invalid writer document turn");
    expect(r.prompts[0].instruction).toContain("No valid designated writer is recorded");
    expect(r.prompts[0].instruction).toContain("do not edit the document");
    r.release(r.prompts[0], "Review only");
    await r.wait(() => r.relay.events.some(e => e.content === "Review only"), "review response");
    expect(r.relay.events.find(e => e.content === "Review only")!.tags.some(tag => tag[0] === "writer")).toBe(false);
  }, 30_000);

  test("a legacy no-writer request designates only its sole agent recipient", async () => {
    const r = runtime = await startAcpRuntime();
    const single = await r.send("Please edit this passage.", [["h", TEST_CHANNEL], ["d", "legacy-page"], ["p", r.agentPk]], 40101);
    await r.wait(() => r.prompts.length === 1, "legacy single-recipient document turn");
    expect(r.prompts[0].instruction).toContain("You are the designated writer");
    r.release(r.prompts[0], "Legacy edit answer");
    await r.wait(() => r.relay.events.some(e => e.content === "Legacy edit answer"), "legacy document response");
    expect(r.relay.events.find(e => e.content === "Legacy edit answer")!.tags).toContainEqual(["writer", r.agentPk]);

    await r.send("Could both of you review this?", [["h", TEST_CHANNEL], ["d", "shared-page"], ["p", r.agentPk], ["p", r.owner.getPubkey()]], 40101);
    await r.wait(() => r.prompts.length === 2, "legacy multi-recipient document turn");
    expect(r.prompts[1].instruction).toContain("No valid designated writer is recorded");
    expect(r.prompts[1].instruction).toContain("do not edit the document");
    r.release(r.prompts[1], "Shared review answer");
    await r.wait(() => r.relay.events.some(e => e.content === "Shared review answer"), "shared review response");
    expect(r.relay.events.find(e => e.content === "Shared review answer")!.tags.some(tag => tag[0] === "writer")).toBe(false);
    expect(single.tags.some(tag => tag[0] === "writer")).toBe(false);
  }, 30_000);

  test.each([false, true])("rejecting a queued member still drains an allowed request (shared thread: %s)", async (sharedThread) => {
    const r = runtime = await startAcpRuntime();
    const memberKey = generateSecretKey();
    const member = getPublicKey(memberKey);
    await r.send("", [["p", member]], 47006);
    await r.publish(r.owner.signEvent({ kind: 47102, created_at: Math.floor(Date.now() / 1000) + 1,
      tags: [["d", "roster"], ["p", r.owner.getPubkey(), "owner"], ["p", r.agentPk, "bot"], ["p", member, "member"]], content: "" }));
    await r.send("@scope-test ACTIVE_A");
    await r.wait(() => r.prompts.length === 1, "active owner turn");
    const memberTags = [["h", TEST_CHANNEL], ["e", "b".repeat(64), "", "root"]];
    await r.publish(finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000),
      tags: memberTags, content: "@scope-test REVOKED_B" }, memberKey));
    await r.wait(() => r.output.includes("queued for"), "member B queued");
    const next = await r.send("@scope-test ALLOWED_C", sharedThread ? memberTags : [["h", TEST_CHANNEL]]);
    await r.wait(() => (r.output.match(/queued for/g) ?? []).length === 2, "owner C queued");
    await r.send("", [["d", "bans"], ["p", member]], 30047);
    r.release(r.prompts[0], "A finished");
    await r.wait(() => r.prompts.length === 2 || r.output.includes("not on the workspace roster"), "queued batch rechecked");
    await r.wait(() => r.prompts.length === 2, "owner C drains after rejected B");
    expect(r.prompts[1].instruction).toContain("ALLOWED_C");
    expect(r.prompts[1].instruction).not.toContain("REVOKED_B");
    r.release(r.prompts[1], "C finished");
    await r.wait(() => r.relay.events.some((event) => event.content === "C finished"), "owner C reply");
    expect(r.relay.events.find((event) => event.content === "C finished")!.tags).toContainEqual(["e", next.id, "", "reply"]);
  }, 30_000);

  test.each([TEST_CHANNEL, OTHER_CHANNEL])("unrelated threads in %s queue without steering or sharing session context", async (channelId) => {
    const r = runtime = await startAcpRuntime();
    const first = await r.send("@scope-test PRIVATE_THREAD_A");
    await r.wait(() => r.prompts.length === 1, "first turn");
    const a = r.prompts[0];
    const otherRoot = "b".repeat(64);
    const tags = [["h", channelId], ["e", otherRoot, "", "root"]];
    await r.send("@scope-test PRIVATE_THREAD_B", tags);
    await r.wait(() => r.output.includes("queued for") || r.aborted.length > 0, "second thread admission");
    expect(r.aborted).toEqual([]);
    const second = await r.send("@scope-test THREAD_B_FOLLOWUP", tags);
    await r.wait(() => (r.output.match(/queued for/g) ?? []).length === 2, "same-thread followup queued");
    r.release(a, "answer A");
    await r.wait(() => r.prompts.length === 2, "second thread turn");
    const b = r.prompts[1];
    expect(b.session).not.toBe(a.session);
    expect(b.instruction).toContain("PRIVATE_THREAD_B");
    expect(b.instruction).toContain("THREAD_B_FOLLOWUP");
    expect(b.instruction).not.toContain("PRIVATE_THREAD_A");
    r.release(b, "answer B");
    await r.wait(() => r.relay.events.some((event) => event.content === "answer B"), "second thread reply");
    const reply = r.relay.events.find((event) => event.content === "answer B")!;
    expect(reply.tags).toContainEqual(["e", otherRoot, "", "root"]);
    expect(reply.tags).toContainEqual(["e", second.id, "", "reply"]);
    await r.send("@scope-test FOLLOW_UP_A", [["h", TEST_CHANNEL], ["e", first.id, "", "root"]]);
    await r.wait(() => r.prompts.length === 3, "first thread continuation");
    expect(r.prompts[2].session).toBe(a.session);
    expect(r.prompts[2].instruction).not.toContain("PRIVATE_THREAD_B");
    r.release(r.prompts[2]);
  }, 30_000);

  test("queued document work retains its comment thread and cannot batch with channel work", async () => {
    const r = runtime = await startAcpRuntime("queue");
    await r.send("@scope-test CHANNEL_BLOCKER");
    await r.wait(() => r.prompts.length === 1, "blocking turn");
    const docRoot = "d".repeat(64);
    await r.send("@scope-test DOCUMENT_REQUEST", [["h", TEST_CHANNEL], ["p", r.agentPk], ["e", docRoot], ["d", "routing-page"], ["anchor", "unique anchor"], ["writer", r.agentPk]], 40101);
    await r.wait(() => r.output.includes("queued for"), "document queued");
    const channel = await r.send("@scope-test CHANNEL_REQUEST");
    await r.wait(() => (r.output.match(/queued for/g) ?? []).length === 2, "channel queued");
    r.release(r.prompts[0], "blocker done");
    await r.wait(() => r.prompts.length === 2, "document turn");
    const doc = r.prompts[1];
    expect(doc.instruction).toContain("DOCUMENT_REQUEST");
    expect(doc.instruction).toContain("unique anchor");
    expect(doc.instruction).toContain("You are the designated writer");
    expect(doc.instruction).not.toContain("CHANNEL_REQUEST");
    r.release(doc, "doc answer");
    await r.wait(() => r.relay.events.some((event) => event.content === "doc answer"), "document reply");
    const reply = r.relay.events.find((event) => event.content === "doc answer")!;
    expect(reply.kind).toBe(40101);
    expect(reply.tags).toContainEqual(["e", docRoot]);
    expect(reply.tags).toContainEqual(["d", "routing-page"]);
    expect(reply.tags).toContainEqual(["writer", r.agentPk]);
    await r.wait(() => r.prompts.length === 3, "channel turn");
    expect(r.prompts[2].instruction).toContain("CHANNEL_REQUEST");
    expect(r.prompts[2].instruction).not.toContain("DOCUMENT_REQUEST");
    r.release(r.prompts[2], "channel answer");
    await r.wait(() => r.relay.events.some((event) => event.content === "channel answer"), "channel reply");
    expect(r.relay.events.find((event) => event.content === "channel answer")!.tags).toContainEqual(["e", channel.id, "", "reply"]);
  }, 30_000);

  test("document replies inherit their root anchor and page when queued or sent independently", async () => {
    const r = runtime = await startAcpRuntime("queue");
    await r.send("@scope-test ACTIVE_CHANNEL");
    await r.wait(() => r.prompts.length === 1, "blocking channel turn");
    const root = await r.send("@scope-test DOC_ROOT", [["h", TEST_CHANNEL], ["p", r.agentPk], ["d", "review-page"], ["anchor", "UNIQUE_ROOT_ANCHOR"], ["writer", r.agentPk]], 40101);
    await r.wait(() => r.output.includes("queued for"), "document root queued");
    const tags = [["h", TEST_CHANNEL], ["p", r.agentPk], ["e", root.id]];
    await r.send("@scope-test DOC_FOLLOWUP", tags, 40101);
    await r.wait(() => (r.output.match(/queued for/g) ?? []).length === 2, "document reply queued");
    r.release(r.prompts[0], "channel finished");
    await r.wait(() => r.prompts.length === 2, "batched document turn");
    expect(r.prompts[1].instruction).toContain("DOC_ROOT");
    expect(r.prompts[1].instruction).toContain("DOC_FOLLOWUP");
    expect(r.prompts[1].instruction).toContain("UNIQUE_ROOT_ANCHOR");
    expect(r.prompts[1].instruction).toContain("You are the designated writer");
    r.release(r.prompts[1], "batched doc answer");
    await r.wait(() => r.relay.events.some((event) => event.content === "batched doc answer"), "batched document reply");
    const reply = r.relay.events.find((event) => event.content === "batched doc answer")!;
    expect(reply.kind).toBe(40101);
    expect(reply.tags).toContainEqual(["e", root.id]);
    expect(reply.tags).toContainEqual(["d", "review-page"]);
    expect(reply.tags).toContainEqual(["writer", r.agentPk]);
    await r.send("@scope-test INDEPENDENT_DOC_FOLLOWUP", tags, 40101);
    await r.wait(() => r.prompts.length === 3, "independent document reply turn");
    expect(r.prompts[2].instruction).toContain("UNIQUE_ROOT_ANCHOR");
    expect(r.prompts[2].instruction).toContain("review-page");
    r.release(r.prompts[2], "independent doc answer");
    await r.wait(() => r.relay.events.some((event) => event.content === "independent doc answer"), "independent document answer");
  }, 30_000);

  test("document steering stays in its thread and owner cancellation discards its followups", async () => {
    const r = runtime = await startAcpRuntime();
    const doc = await r.send("@scope-test DOC_ORIGINAL", [["h", TEST_CHANNEL], ["p", r.agentPk], ["d", "routing-page"], ["anchor", "steering anchor"], ["writer", r.agentPk]], 40101);
    await r.wait(() => r.prompts.length === 1, "document turn");
    const tags = [["h", TEST_CHANNEL], ["p", r.agentPk], ["e", doc.id], ["d", "routing-page"], ["writer", r.owner.getPubkey()]];
    await r.send("@scope-test DOC_UPDATE", tags, 40101);
    await r.wait(() => r.aborted.length === 1, "same document steer");
    r.release(r.prompts[0]);
    await r.wait(() => r.prompts.length === 2, "merged document turn");
    expect(r.prompts[1].instruction).toContain("DOC_UPDATE");
    expect(r.prompts[1].instruction).toContain("steering anchor");
    expect(r.prompts[1].instruction).toContain("You are a reviewer for this request");
    r.release(r.prompts[1], "steered doc answer");
    await r.wait(() => r.relay.events.some((event) => event.content === "steered doc answer"), "steered document reply");
    const steeredReply = r.relay.events.find((event) => event.content === "steered doc answer")!;
    expect(steeredReply.kind).toBe(40101);
    expect(steeredReply.tags).toContainEqual(["writer", r.owner.getPubkey()]);
    await r.send("@scope-test DOC_NEXT", tags, 40101);
    await r.wait(() => r.prompts.length === 3, "next document turn");
    await r.send("@scope-test CANCELLED_FOLLOWUP", tags, 40101);
    await r.wait(() => r.aborted.length === 2, "second document steer");
    await r.cancel();
    await r.wait(() => r.output.includes("owner cancelled the in-flight turn"), "owner cancellation");
    r.release(r.prompts[2]);
    await r.wait(() => r.relay.events.some((event) => event.content.includes("stopped by my owner")), "cancellation notice");
    await r.send("@scope-test AFTER_CANCEL");
    await r.wait(() => r.prompts.length === 4, "new channel turn after cancellation");
    expect(r.prompts[3].instruction).toContain("AFTER_CANCEL");
    expect(r.prompts[3].instruction).not.toContain("CANCELLED_FOLLOWUP");
    r.release(r.prompts[3], "after cancel answer");
    await r.wait(() => r.relay.events.some((event) => event.content === "after cancel answer"), "post-cancel reply");
  }, 30_000);

  test("a delayed retry keeps the document anchor and publishes back into the comment thread", async () => {
    const r = runtime = await startAcpRuntime();
    const doc = await r.send("@scope-test RETRY_DOC", [["h", TEST_CHANNEL], ["p", r.agentPk], ["d", "retry-page"], ["anchor", "retry anchor"], ["writer", r.agentPk]], 40101);
    await r.wait(() => r.prompts.length === 1, "initial document turn");
    r.release(r.prompts[0], "", "ECONNRESET");
    await r.wait(() => r.prompts.length === 2, "immediate session replay");
    r.release(r.prompts[1], "", "ECONNRESET");
    await r.wait(() => r.output.includes("retry 1/3"), "delayed turn retry queued");
    await r.wait(() => r.prompts.length === 3, "delayed document retry");
    expect(r.prompts[2].instruction).toContain("retry anchor");
    expect(r.prompts[2].instruction).toContain("RETRY_DOC");
    r.release(r.prompts[2], "retried doc answer");
    await r.wait(() => r.relay.events.some((event) => event.content === "retried doc answer"), "retried document reply");
    const reply = r.relay.events.find((event) => event.content === "retried doc answer")!;
    expect(reply.kind).toBe(40101);
    expect(reply.tags).toContainEqual(["e", doc.id]);
    expect(reply.tags).toContainEqual(["d", "retry-page"]);
    expect(reply.tags).toContainEqual(["writer", r.agentPk]);
  }, 30_000);
});
