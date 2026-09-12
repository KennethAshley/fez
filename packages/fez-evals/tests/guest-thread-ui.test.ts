// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrEvent } from "nostr-tools/pure";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { GuestThreadView, useGuestUnreads, type Guest } from "../../fez-desktop/src/guest-threads.js";
import type { BrowserWire } from "../../fez-desktop/src/wire.js";
import { readGuestJobs } from "../../fez-desktop/src/guest-job.js";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import { deriveSalt } from "../../fez-client/src/salt.js";
import type { fetchSaltPanel } from "../../fez-desktop/src/salt-record.js";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), salt: vi.fn() }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: mocks.invoke }));
vi.mock("../../fez-desktop/src/relay.js", () => ({ relaySet: () => [] }));
vi.mock("../../fez-desktop/src/salt-record.js", () => ({
  fetchSaltPanel: mocks.salt, invalidateSaltPanel: () => {}, tierLabel: () => "", tierTitle: () => "",
}));

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (message: { data: string }) => void;
  sent: unknown[][] = [];
  constructor() { Socket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  event(event: NostrEvent, subscription = "gt-them") {
    this.onmessage?.({ data: JSON.stringify(["EVENT", subscription, event]) });
  }
}
const ownerKey = generateSecretKey(), workerKey = generateSecretKey();
const ownerPk = getPublicKey(ownerKey), workerPk = getPublicKey(workerKey);
const guest: Guest = { pk: workerPk, name: "specialist", relay: "wss://market.example" };
const payTo = "5" + "A".repeat(47), payerAddress = "5" + "B".repeat(47);
const scope = { ownerPk, guestPk: workerPk, relay: guest.relay };
const signed = (key: Uint8Array, kind: number, content: string, tags: string[][] = [], at = Math.floor(Date.now() / 1000)) =>
  finalizeEvent({ kind, content, tags, created_at: at }, key);
const task = () => signed(ownerKey, 47001, "Make the spoken deliverable", [["p", workerPk], ["task_type", "research-citations"]]);
const capabilityOutput = () => ({ code: 0, stderr: "", stdout: JSON.stringify({ guestPayments: 1,
  identity: { persona: "buyer", payerAddress, renterPubkey: "9".repeat(64) } }) });

beforeEach(() => {
  localStorage.clear();
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { locks: { request: async (_key: string, _options: unknown, action: (lock: object) => Promise<void>) => action({}) } });
  mocks.invoke.mockReset();
  mocks.salt.mockReset().mockResolvedValue("error");
  mocks.invoke.mockImplementation(async (command: string, input?: { args?: string[] }) => command === "extension_storage_read"
    ? JSON.stringify({ addresses: { personas: { buyer: payerAddress } } }) : input?.args?.[0] === "capabilities" ? capabilityOutput() : "{}");
  Element.prototype.scrollIntoView = vi.fn();
});

async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll("button")].find(button => button.textContent === label)!;
  expect(button).toBeDefined();
  expect(button.disabled, host.textContent ?? "").toBe(false);
  await act(async () => button.click());
}
async function fill(host: HTMLElement, label: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const prototype = field.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function agree(view: Awaited<ReturnType<typeof render>>) {
  const oldTask = signed(ownerKey, 47001, "An older unrelated job", [["p", workerPk]], Math.floor(Date.now() / 1000) - 10);
  const request = task();
  const announce = signed(workerKey, 47000, JSON.stringify({ pay_to: payTo }));
  await act(async () => {
    view.socket.event(announce, "gt-pay");
    view.socket.event(oldTask, "gt-mine");
    view.socket.event(request, "gt-mine");
  });
  await click(view.host, "start a hire");
  await fill(view.host, "Job to hire for", request.id);
  await fill(view.host, "Agreed price in tTAO", "0.1");
  await click(view.host, "lock terms · pay after acceptance");
  return { request, oldTask, announce };
}

it("pays the chosen job and captured recipient after a verified result, despite a later address change", async () => {
  const view = await render();
  try {
    const { request, oldTask, announce } = await agree(view);
    const payment = [...view.host.querySelectorAll("button")].find(button => button.textContent === "accept result & pay")!;
    expect(payment.disabled).toBe(true);
    const response = (id: string) => signed(workerKey, 47003, JSON.stringify({ status: "success", result: "Finished audio" }), [["e", id, "", "root"], ["p", ownerPk]]);
    await act(async () => {
      view.socket.event(response(oldTask.id));
      view.socket.event(signed(workerKey, 47000, JSON.stringify({ pay_to: "5" + "C".repeat(47) }), [], announce.created_at + 1), "gt-pay");
    });
    expect(payment.disabled).toBe(true);
    const result = response(request.id);
    await act(async () => view.socket.event(result));
    mocks.invoke.mockImplementation(async (command: string, input: { args?: string[] }) => {
      if (command !== "run_extension_bin") return "{}";
      if (input.args?.[0] === "capabilities") return capabilityOutput();
      expect(input.args).toEqual(["pay", payTo, "0.1", "--as", "buyer", "--expect-payer", payerAddress,
        "--to-pk", workerPk, "--for", request.id, "--market", guest.relay, "--json"]);
      return { code: 0, stderr: "", stdout: JSON.stringify({ persona: "buyer", payerAddress, to: payTo, amount: "0.1", network: "test", txHash: "0x" + "e".repeat(64) }) };
    });
    await click(view.host, "accept result & pay");
    expect(readGuestJobs(localStorage, scope)[0]).toMatchObject({ requestId: request.id, state: "paid", payTo, acceptedResultId: result.id });
    expect(view.host.textContent).toContain("Status: paid");
  } finally { await view.close(); }
});

it("blocks repeat payment after an uncertain wallet outcome and a remount", async () => {
  const view = await render();
  try {
    const { request } = await agree(view);
    await act(async () => view.socket.event(signed(workerKey, 47003, JSON.stringify({ status: "success", result: "Finished" }), [["e", request.id, "", "root"], ["p", ownerPk]])));
    mocks.invoke.mockImplementation(async (command: string, input?: { args?: string[] }) => input?.args?.[0] === "capabilities" ? capabilityOutput()
      : command === "run_extension_bin" ? { code: 1, stdout: "", stderr: "transfer confirmation timed out" } : "{}");
    await click(view.host, "accept result & pay");
    expect(readGuestJobs(localStorage, scope)[0]?.state).toBe("unknown");
    expect(view.host.textContent).toContain("another payment is blocked");
  } finally { await view.close(); }
  const reopened = await render();
  try {
    expect(reopened.host.textContent).toContain("Status: unknown");
    expect([...reopened.host.querySelectorAll("button")].some(button => button.textContent === "accept result & pay")).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([, input]) => input?.args?.[0] === "pay")).toHaveLength(1);
  } finally { await reopened.close(); }
});

it("reloads an older job's exact result before enabling acceptance", async () => {
  const view = await render();
  const { request } = await agree(view);
  await view.close();
  const reopened = await render();
  try {
    expect(reopened.socket.sent).toContainEqual(["REQ", "gt-job-results", { kinds: [47003], authors: [workerPk], "#e": [request.id] }]);
    await act(async () => {
      reopened.socket.event(request, "gt-jobs");
      reopened.socket.event(signed(workerKey, 47003, JSON.stringify({ status: "success", result: "Recovered deliverable" }), [["e", request.id, "", "root"], ["p", ownerPk]]), "gt-job-results");
    });
    const payment = [...reopened.host.querySelectorAll("button")].find(button => button.textContent === "accept result & pay")!;
    expect(payment.disabled).toBe(false);
    expect(reopened.host.textContent).toContain("Recovered deliverable");
  } finally { await reopened.close(); }
});

it("does not offer paid priority for a different task-author identity", async () => {
  const view = await render();
  try {
    const request = task();
    await act(async () => {
      view.socket.event(request, "gt-mine");
      view.socket.event(signed(workerKey, 47000, JSON.stringify({ pay_to: payTo, rate: { tao_hr: 0.4, pay_to: payTo } })), "gt-pay");
    });
    await click(view.host, "start a hire");
    await fill(view.host, "Job to hire for", request.id);
    const leaseButtons = [...view.host.querySelectorAll("button")].filter(button => /^(15m|1h) ·/.test(button.textContent ?? ""));
    expect(leaseButtons).toHaveLength(2);
    expect(leaseButtons.every(button => button.disabled)).toBe(true);
    expect(view.host.textContent).toContain("This owner conversation cannot use that lease");
    expect(mocks.invoke.mock.calls.some(([, input]) => input?.args?.[0] === "rent")).toBe(false);
  } finally { await view.close(); }
});

it("blocks an older wallet before it can ignore payment guard flags", async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "extension_storage_read"
    ? JSON.stringify({ addresses: { personas: { buyer: payerAddress } } }) : { code: 0, stderr: "", stdout: "{}" });
  const view = await render();
  try {
    await act(async () => view.socket.event(signed(workerKey, 47000, JSON.stringify({ pay_to: payTo })), "gt-pay"));
    expect(view.host.textContent).toContain("wallet update");
    const start = [...view.host.querySelectorAll("button")].find(button => button.textContent === "start a hire")!;
    expect(start.disabled).toBe(true);
    expect(mocks.invoke.mock.calls.some(([, input]) => ["pay", "rent", "escrow"].includes(input?.args?.[0]))).toBe(false);
  } finally { await view.close(); }
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function render(unreads = false, client?: FezClient) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Unreads() {
    const counts = useGuestUnreads([guest], ownerPk);
    return React.createElement("span", null, counts[workerPk] ?? 0);
  }
  await act(async () => root.render(unreads
    ? React.createElement(Unreads)
    : React.createElement(GuestThreadView, { guest, selfPk: ownerPk, client, wire: {
      signEvent: async (template: { kind: number; content: string; tags: string[][]; created_at?: number }) => finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...template }, ownerKey),
    } as BrowserWire })));
  const socket = Socket.all.at(-1)!;
  await act(async () => socket.onopen?.());
  if (!unreads) expect(mocks.invoke.mock.calls, "wallet mirror should be read").toContainEqual(["extension_storage_read", { name: "wallet" }]);
  return { host, socket, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("shows a workspace endorser by name and in the correct circle in guest reputation", async () => {
  const client = new FezClient({ pubkey: ownerPk } as Wire);
  const alice = "a".repeat(64);
  client.state.workspace.members.set(alice, "member");
  vi.spyOn(client, "displayName").mockReturnValue("Alice");
  mocks.salt.mockImplementation(async (opts: Parameters<typeof fetchSaltPanel>[0]) => deriveSalt({
    ...opts, agent: opts.pk, attestations: [],
    evidence: [{ signer: alice, kind: "vouch", note: "Thorough researcher", at: 100, moneyBacked: false }],
  }));
  const view = await render(false, client);
  try {
    const reputation = view.host.querySelector(".guest-reputation")!;
    expect(reputation.textContent).toContain("Alice");
    expect(reputation.textContent).toContain("In your circle");
    expect(view.host.textContent).not.toContain("summon anyway?");
    expect(mocks.salt.mock.calls[0][0].relays).toContain(guest.relay);
  } finally { await view.close(); }
});

it("does not expose a payment destination from a forged announce", async () => {
  const view = await render();
  try {
    const event = signed(workerKey, 47000, JSON.stringify({ pay_to: "5" + "A".repeat(47) }));
    await act(async () => view.socket.event({ ...event, sig: "0".repeat(128) }, "gt-pay"));
    expect(view.host.textContent).not.toContain("hireable");
    expect(view.host.textContent).toContain("no receive address");
  } finally { await view.close(); }
});

it("ignores an old socket's acknowledgement after reconnect", async () => {
  vi.useFakeTimers();
  const view = await render();
  try {
    await act(async () => view.socket.onclose?.());
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    const current = Socket.all.at(-1)!;
    expect(current).not.toBe(view.socket);
    await act(async () => current.onopen?.());
    const composer = view.host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "A new request after reconnect");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(view.host, "send");
    const published = current.sent.find(frame => frame[0] === "EVENT")?.[1] as NostrEvent;
    expect(published).toBeDefined();
    await act(async () => {
      view.socket.onmessage?.({ data: JSON.stringify(["OK", published.id, true]) });
      view.socket.onclose?.();
    });
    expect(view.host.textContent).toContain("sending…");
    await act(async () => current.onmessage?.({ data: JSON.stringify(["OK", published.id, true]) }));
    expect(view.host.textContent).not.toContain("sending…");
    expect(view.host.textContent).not.toContain("connection dropped");
  } finally { await view.close(); vi.useRealTimers(); }
});

it("keeps a signed task for another specialist out of this conversation", async () => {
  const view = await render();
  try {
    await act(async () => view.socket.event(signed(ownerKey, 47001, "Unrelated private-looking brief", [["p", "a".repeat(64)]]), "gt-mine"));
    expect(view.host.textContent).not.toContain("Unrelated private-looking brief");
  } finally { await view.close(); }
});

it("counts a verified reply arriving before its task, and ignores a forged reply", async () => {
  const view = await render(true);
  try {
    const request = task();
    const reply = signed(workerKey, 47003, JSON.stringify({ status: "success", result: "Ready" }), [["e", request.id, "", "root"], ["p", ownerPk]]);
    await act(async () => view.socket.event(reply, "gu-ans"));
    expect(view.host.textContent).toBe("0");
    await act(async () => view.socket.event(request, "gu-mine"));
    expect(view.host.textContent).toBe("1");
    await act(async () => view.socket.event({ ...reply, id: "a".repeat(64) }, "gu-ans"));
    expect(view.host.textContent).toBe("1");
  } finally { await view.close(); }
});
