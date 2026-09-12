import { expect, it } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { parseGuestEvent, parseGuestOffer, isGuestReplyTo, replaceableEventWins } from "../../fez-client/src/guest-protocol.js";
const ownerKey = new Uint8Array(32).fill(21), guestKey = new Uint8Array(32).fill(22), otherKey = new Uint8Array(32).fill(23);
const selfPk = getPublicKey(ownerKey), guestPk = getPublicKey(guestKey), otherPk = getPublicKey(otherKey);
const scope = { selfPk, guestPk, nowS: 1000 };
const address = "5GrwvaEF5zXb26Fz9rcQpDWS64QpW8ycvDLe4HwvuPHhk7G7", otherAddress = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const event = (kind: number, content: unknown, tags: string[][] = [], key = guestKey, created_at = 1000): Event => finalizeEvent({ kind, content: typeof content === "string" ? content : JSON.stringify(content), tags, created_at }, key);
const task = event(47001, "Fix invoice.", [["p", guestPk], ["task_type", "repo-work"]], ownerKey);
const tags = [["e", task.id, "", "root"], ["p", selfPk]];
const reply = (status = "success", refs = tags) => event(47003, { status, result: "Delivered the branch." }, refs);

it("binds an exact signed owner task and guest result, preserving signed bytes", () => {
  const ask = parseGuestEvent(task, scope), answer = parseGuestEvent(reply(), scope);
  expect(ask?.type).toBe("task");
  expect(answer).toMatchObject({ type: "result", taskId: task.id, status: "success", result: "Delivered the branch." });
  expect(isGuestReplyTo(answer!, ask!)).toBe(true);
  expect(answer?.event.content).toBe(reply().content);
});
it("rechecks bytes rather than trusting cached verification after mutation", () => {
  const forged = event(47000, { pay_to: address });
  expect(verifyEvent(forged)).toBe(true);
  forged.content = JSON.stringify({ pay_to: otherAddress });
  expect(parseGuestEvent(forged, scope)).toBeNull();
});
it("rejects unsigned, wrong-author, wrong-kind and malformed envelopes", () => {
  const good = event(0, { name: "guest" });
  for (const value of [null, [], {}, { ...good, sig: undefined }, { ...good, tags: null }, { ...good, created_at: NaN }, event(0, { name: "impostor" }, [], otherKey), event(47040, {})]) expect(parseGuestEvent(value, scope)).toBeNull();
});
it("requires exact participants even when relay filters were ignored", () => {
  expect(parseGuestEvent(event(47001, "Other hire", [["p", otherPk]], ownerKey), scope)).toBeNull();
  expect(parseGuestEvent(event(47001, "Fake ask", [["p", guestPk]], otherKey), scope)).toBeNull();
  expect(parseGuestEvent(event(47001, "Ambiguous", [["p", guestPk], ["p", otherPk]], ownerKey), scope)).toBeNull();
  expect(parseGuestEvent(reply("success", [["e", task.id, "", "root"], ["p", otherPk]]), scope)).toBeNull();
  expect(parseGuestEvent(event(47003, { status: "success", result: "Wrong worker" }, tags, otherKey), scope)).toBeNull();
});
it("stages early replies but unrelated or ambiguous roots never deliver", () => {
  const early = parseGuestEvent(reply(), scope)!;
  expect(isGuestReplyTo(early, parseGuestEvent(task, scope)!)).toBe(true);
  expect(isGuestReplyTo(early, parseGuestEvent(event(47001, "Other request", [["p", guestPk]], ownerKey), scope)!)).toBe(false);
  for (const refs of [[["e", task.id, "", "root"], ["e", "a".repeat(64), "", "root"]], [["e", task.id, "", "mention"]], [["e", task.id], ["e", "a".repeat(64)]]]) expect(parseGuestEvent(reply("success", [...refs, ["p", selfPk]]), scope)).toBeNull();
  expect(parseGuestEvent(reply("success", [["e", task.id], ["p", selfPk]]), scope)).toMatchObject({ taskId: task.id });
});
it.each(["success", "failure", "error", "declined", "cancelled", "timeout"])("preserves explicit status %s", status => {
  expect(parseGuestEvent(reply(status), scope)).toMatchObject({ type: "result", status });
});
it("does not invent successful delivery from malformed or incomplete result data", () => {
  for (const content of ["plain answer", { result: "No status" }, { status: "working", result: "Not done" }, { status: "success", result: "" }]) expect(parseGuestEvent(event(47003, content, tags), scope)).toBeNull();
  expect(parseGuestEvent(event(47003, { status: "failure", error: { message: "Could not finish." } }, tags), scope)).toMatchObject({ status: "failure", result: "Could not finish." });
  expect(parseGuestEvent(event(47003, { status: "success", result: { branch: "fix/invoice" } }, tags), scope)).toMatchObject({ result: '{"branch":"fix/invoice"}' });
});
it("progress is bound to the task but never a terminal result", () => {
  const update = parseGuestEvent(event(47002, { status: "working", message: "Editing" }, tags), scope)!;
  expect(update).toMatchObject({ type: "progress", taskId: task.id, message: "Editing" });
  expect(isGuestReplyTo(update, parseGuestEvent(task, scope)!)).toBe(true);
});
it("validates profile strings and blocks executable image URLs", () => {
  expect(parseGuestEvent(event(0, { name: "Speaker", picture: "https://example.test/avatar.png" }), scope)).toMatchObject({ type: "profile", profile: { name: "Speaker", picture: "https://example.test/avatar.png" } });
  for (const content of [{ name: {} }, { name: "bad\nname" }, { picture: "javascript:alert(1)" }, { picture: "data:image/svg+xml,evil" }]) expect(parseGuestEvent(event(0, content), scope)).toMatchObject({ type: "profile", profile: null });
});
it("bounds metadata future timestamps and orders replacements deterministically", () => {
  const a = event(47000, { pay_to: address }), b = event(47000, { pay_to: otherAddress });
  expect(replaceableEventWins(a, b)).toBe(a.id < b.id);
  expect(replaceableEventWins(event(47000, {}, [], guestKey, 999), a)).toBe(false);
  for (const kind of [0, 47000, 47041]) expect(parseGuestEvent(event(kind, {}, [], guestKey, 1061), scope)).toBeNull();
});
it("retains newest invalid or withdrawn metadata so old offers can be cleared", () => {
  const old = parseGuestEvent(event(47000, { pay_to: address }, [], guestKey, 999), scope)!;
  const invalid = parseGuestEvent(event(47000, { pay_to: "bad address" }), scope)!;
  expect(invalid).toMatchObject({ type: "announce", offer: null });
  expect(replaceableEventWins(invalid.event, old.event)).toBe(true);
  expect(parseGuestEvent(event(47000, {}), scope)).toMatchObject({ type: "announce", offer: {} });
  expect(parseGuestEvent(event(47041, ""), scope)).toMatchObject({ type: "binding", retired: true });
});
it("shares nested rate.pay_to and rejects conflicting payees or malformed rates", () => {
  expect(parseGuestOffer({ rate: { tao_hr: 0.02, pay_to: address } })).toEqual({ payTo: address, rateTaoHr: 0.02 });
  expect(parseGuestOffer({ pay_to: address, rate: { tao_hr: 0.02, pay_to: address } })).toEqual({ payTo: address, rateTaoHr: 0.02 });
  expect(parseGuestOffer({ pay_to: address, rate: { tao_hr: 0 } })).toEqual({ payTo: address });
  for (const payload of [null, [], { pay_to: " " + address }, { pay_to: {} }, { rate: { tao_hr: -1 } }, { rate: { tao_hr: Infinity } }, { rate: { tao_hr: "2" } }, { pay_to: address, rate: { pay_to: otherAddress, tao_hr: 1 } }]) expect(parseGuestOffer(payload)).toBeNull();
  expect(parseGuestOffer({ pay_to: address }, () => false)).toBeNull();
});

it("rejects coercible statuses and conflicting marked task references", () => {
  expect(parseGuestEvent(event(47003, { status: ["success"], result: "Do not coerce" }, tags), scope)).toBeNull();
  expect(parseGuestEvent(reply("success", [["e", task.id, "", "root"], ["e", "a".repeat(64), "", "reply"], ["p", selfPk]]), scope)).toBeNull();
});
