/** One bounded testnet hire through the real wallet and Bazaar MCP tools. Never retries payment. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "../../../fez-bazaar/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../../fez-bazaar/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { marketDirectory } from "../../../fez-bazaar/src/bridge/directory.ts";
import { resolveMinerSecret } from "../../../fez-bazaar/src/miner/keys.ts";
import { walletAskKey } from "../../../fez-bazaar/src/bridge/core.ts";
import { loadConfig, endpointFor } from "../../packages/fez-wallet/src/config.ts";
import { subtensorFor } from "../../packages/fez-wallet/src/stake.ts";
import { parseReceipt, verifyReceipt } from "../../packages/fez-wallet/src/receipt.ts";

const root = path.resolve(import.meta.dir, "../..");
const out = path.join(root, "docs/experiments/2026-09-09-bazaar-lebron-air");
fs.mkdirSync(out, { recursive: true });
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");
const requireBazaar = createRequire(path.resolve(root, "../fez-bazaar/package.json"));
const { Relay, useWebSocketImplementation } = requireBazaar("nostr-tools/relay");
const { getPublicKey, verifyEvent } = requireBazaar("nostr-tools");
useWebSocketImplementation(requireBazaar("ws"));
const relayUrl = "wss://bazaar.fez.chat";
const fixture = JSON.parse(fs.readFileSync(path.join(out, "fixture.json"), "utf8"));
const target: string = fixture.target;
const persona = "drift";
const hours = 0.05;
const amountRao = 5_000_000n;
const config = loadConfig();
assert.equal(config.network, "test");
assert.equal(config.endpoints.tao, endpointFor("test"));
assert(!fs.existsSync(path.join(out, "lease-attempt.json")), "Payment already attempted; inspect saved evidence instead of rerunning.");
const key = walletAskKey(persona, target, name => resolveMinerSecret(name, {}));
const payer = getPublicKey(key);
key.fill(0);
const mirror = JSON.parse(fs.readFileSync("/Users/ken/.fez/extension-data/wallet.json", "utf8"));
const payerAddress = mirror.addresses.personas[persona];
const api = await subtensorFor(config.endpoints.tao);
const relay = await Relay.connect(relayUrl);
const wallet = new Client({ name: "bazaar-hire-pilot-wallet", version: "1" });
const bazaar = new Client({ name: "bazaar-hire-pilot-buyer", version: "1" });
const env = { PATH: process.env.PATH!, FEZ_AGENT_PERSONA: persona, BAZAAR_RELAY: relayUrl };
const events: Array<{ id: string; kind: number; pubkey: string; content: string; created_at: number; tags: string[][]; sig: string }> = [];
const started = Date.now();
const sub = relay.subscribe([{ kinds: [47000, 47001, 47002, 47003, 47040], authors: [payer, target], since: Math.floor(started / 1000) - 900 }], {
  onevent: (ev: typeof events[number]) => {
    assert(verifyEvent(ev)); events.push(ev);
    if (ev.pubkey === target && ev.kind === 47002 && ev.created_at >= Math.floor(started / 1000)) console.log(`LeBron progress: ${ev.content}`);
  },
});
const toolText = (r: { content: Array<{ type: string; text?: string }>; isError?: boolean }) => {
  assert(!r.isError, JSON.stringify(r));
  return r.content.filter(x => x.type === "text").map(x => x.text ?? "").join("\n");
};
try {
  await wallet.connect(new StdioClientTransport({ command: "node", args: ["/Users/ken/.fez/packages/wallet/dist/mcp.js"], env, stderr: "pipe" }));
  await bazaar.connect(new StdioClientTransport({ command: "node", args: ["/Users/ken/.fez/packages/bazaar/dist/bridge.js"], env, stderr: "pipe" }));
  const tools = await bazaar.listTools();
  assert(tools.tools.find(t => t.name === "bazaar_ask")?.inputSchema.properties?.use_wallet_identity);
  // Exercise the actual tool boundary without publishing a task or accessing a wallet.
  const invalid = await bazaar.callTool({ name: "bazaar_ask", arguments: { task: "boundary check", use_wallet_identity: true } });
  assert(invalid.isError);
  save("identity-boundary.json", invalid);
  const directory = await marketDirectory(relayUrl);
  const chosen = directory.find(r => r.pk === target);
  assert.equal(chosen?.online, true);
  assert.notEqual(chosen?.acceptingWork, false, "LeBron reports it cannot accept work");
  assert.equal(chosen?.rateTaoHr, fixture.rateTaoHr);
  const announces = events.filter(e => e.kind === 47000 && e.pubkey === target).sort((a,b) => b.created_at-a.created_at);
  assert(announces.length > 0);
  const offer = JSON.parse(announces[0]!.content).rate;
  assert.equal(offer.tao_hr, fixture.rateTaoHr);
  assert.equal(offer.pay_to, fixture.payTo, "pay the receiving account verified on the Air");
  assert(Math.floor(Date.now()/1000) - announces[0]!.created_at < 360, "fresh offer required");
  assert.equal(BigInt(Math.round(hours * offer.tao_hr * 1e9)), amountRao);
  const freeBefore = (await api.query.system.account(payerAddress)).data.free.toBigInt();
  assert(freeBefore > amountRao + 10_000_000n, "testnet allowance must cover rent and fees");
  save("preflight.json", { at: new Date().toISOString(), network: config.network, genesis: api.genesisHash.toHex(), payer, payerAddress, target, hours, grossRao: amountRao.toString(), freeBeforeRao: freeBefore.toString(), offer, announce: announces[0], directory });
  const ledgerPath = path.join(root, "docs/experiments/2026-09-09-bazaar-hiring-rerun/ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const reservationId = "lebron-air-invoice-specialist";
  const reservation = ledger.find((r: { id: string }) => r.id === reservationId);
  assert(reservation?.state === "reserved-air-startup" && reservation.reservedUsd === 3 && reservation.pk === target, "reuse only the untouched Air startup reservation");
  const accounted = ledger.reduce((sum: number, r: { actualUsd?: number; reservedUsd: number }) => sum + (r.actualUsd ?? r.reservedUsd), 0);
  assert(accounted <= 20, "original cumulative $20 cap, including Air reservation");
  reservation.state = "reserved-for-hire";
  reservation.hireAttemptAt = new Date().toISOString();
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  save("lease-attempt.json", { at: new Date().toISOString(), persona, target, hours, grossRao: amountRao.toString(), network: "test", accountedUsdIncludingReservation: accounted });
  const paid = await wallet.callTool({ name: "wallet_rent", arguments: { miner: target, hours } }, undefined, { timeout: 180_000 });
  save("lease-result.json", paid);
  const paidText = toolText(paid);
  const txHash = /tx (0x[0-9a-f]{64})/i.exec(paidText)?.[1];
  assert(txHash, paidText);
  console.log(`Testnet lease submitted: ${txHash}`);
  const receiptDeadline = Date.now() + 10_000;
  while (!events.some(e => e.kind === 47040 && e.pubkey === payer && e.tags.some(t => t[0] === "tx" && t[1] === txHash)) && Date.now() < receiptDeadline) await Bun.sleep(50);
  const receiptEvent = events.find(e => e.kind === 47040 && e.pubkey === payer && e.tags.some(t => t[0] === "tx" && t[1] === txHash));
  assert(receiptEvent, "lease receipt must arrive before asking for work");
  save("receipt.json", receiptEvent);
  const receipt = parseReceipt(receiptEvent)!;
  assert.equal(receipt.network, "test");
  assert.equal(receipt.payee, target);
  assert(receipt.raw > 0n && receipt.raw <= amountRao);
  const request = { task: fixture.task, task_type: "research-citations", wait_s: 60, max_answers: 1, to: target, use_wallet_identity: true };
  save("ask-attempt.json", { at: new Date().toISOString(), request });
  const answer = await bazaar.callTool({ name: "bazaar_ask", arguments: request }, undefined, { timeout: 90_000 });
  save("ask-result.json", answer);
  let report = JSON.parse(toolText(answer));
  for (let attempt = 0; report.answers.length === 0 && attempt < 2; attempt++) {
    console.log(`Continuing the same task ${report.task_id}; no additional payment.`);
    const waited = await bazaar.callTool({name: "bazaar_wait", arguments: {task_id: report.task_id, wait_s: 60, max_answers: 1}}, undefined, {timeout: 90_000});
    save(`wait-${attempt}.json`, waited);
    report = JSON.parse(toolText(waited));
  }
  save("final-report.json", report);
  const ask = events.find(e => e.kind === 47001 && e.id === report.task_id);
  assert(ask);
  assert.equal(ask.pubkey, receiptEvent.pubkey, "request must use the lease payer identity");
  const block = await api.rpc.chain.getBlock(receipt.blockRef!);
  const index = block.block.extrinsics.findIndex((e: { hash: { toHex(): string } }) => e.hash.toHex() === txHash);
  assert(index >= 0);
  const onBlock = await api.at(receipt.blockRef!);
  const records = await onBlock.query.system.events();
  const matching = [...records].filter(r => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index);
  const chainEvents = matching.map(r => ({ section: r.event.section, method: r.event.method, data: [...r.event.data].map(x => x.toString()) }));
  assert(chainEvents.some(e => e.section === "system" && e.method === "ExtrinsicSuccess"));
  const transfer = chainEvents.find(e => e.section === "balances" && e.method === "Transfer" && e.data[0] === payerAddress && e.data[1] === offer.pay_to);
  assert(transfer, "chain must show the actual transfer to the advertised payee");
  const receiptStatus = await verifyReceipt(receipt, async () => ({ from: transfer.data[0]!, to: transfer.data[1]!, raw: BigInt(transfer.data[2]!) }), { from: payerAddress, to: offer.pay_to });
  assert.equal(receiptStatus, "verified");
  const freeAfter = (await api.query.system.account(payerAddress)).data.free.toBigInt();
  save("verification.json", { at: new Date().toISOString(), network: "test", payer, payerAddress, target, taskId: ask.id, receiptId: receiptEvent.id, txHash, blockRef: receipt.blockRef, grossRao: amountRao.toString(), receivedRao: receipt.raw.toString(), payerDecreaseRao: (freeBefore-freeAfter).toString(), receiptStatus, chainEvents, report, walletRealMoneyUsd: 0 });
  console.log("Payment verified on testnet; checking LeBron's returned ledger.");
  assert.equal(report.successful_answers, 1, "LeBron must return a successful result");
  const raw = report.answers[0].answer.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const returned = JSON.parse(raw);
  let passed = true;
  let mismatch: string | undefined;
  try { assert.deepEqual(returned, fixture.expected); }
  catch (e) { passed = false; mismatch = (e as Error).message; }
  save("quality.json", {passed, expected: fixture.expected, returned, mismatch});
  assert(passed, mismatch);
  console.log("PASS: LeBron's signed answer matches all invoice totals, duplicate/refund handling, and follow-up selection.");
} finally {
  save("wire.json", events.filter(e => e.created_at >= Math.floor(started/1000)-5));
  sub.close(); relay.close();
  await Promise.allSettled([wallet.close(), bazaar.close(), api.disconnect()]);
}
