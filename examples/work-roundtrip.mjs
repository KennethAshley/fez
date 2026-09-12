// Run against a local development relay. Both identities are disposable.
import assert from "node:assert/strict";
import { CapabilityClient, RelayConnection } from "@fezchat/protocol";
import { completeWork, workResult, acceptWork } from "@fezchat/protocol/client";

const url = process.argv[2] ?? "ws://127.0.0.1:7777";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Use a local development relay for this disposable-key example.");
}
const requester = new CapabilityClient({ relay: url });
const worker = new CapabilityClient({ relay: url });
const relay = new RelayConnection({ url });
const requesterKey = requester.getPubkey(), workerKey = worker.getPubkey();

// Reads are signature-verified by RelayConnection; helpers validate correlation,
// not signatures or workspace membership. Real workers must also gate authors.
async function delivered(event) {
  await relay.publish(event);
  const page = await relay.queryWithStatus([{ ids: [event.id], kinds: [event.kind], authors: [event.pubkey] }]);
  assert.deepEqual(page.failures, []);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].id, event.id);
  return page.events[0];
}

try {
  await relay.connect();
  const request = await delivered(requester.signEvent({
    kind: 47103,
    content: "Package roundtrip: make this uppercase.",
    tags: [["h", "npm-demo"], ["p", workerKey], ["task", workerKey], ["result-handler", "external"]],
  }));
  const result = await delivered(worker.signEvent(completeWork(request, workerKey, {
    status: "success", summary: request.content.toUpperCase(), capability: "uppercase", artifacts: [],
  })));
  assert.equal(workResult(result, request), "success");
  // The requester checks the actual deliverable before recording acceptance.
  assert.equal(result.content, "PACKAGE ROUNDTRIP: MAKE THIS UPPERCASE.");
  const acceptance = await delivered(requester.signEvent(acceptWork(
    result, request, requesterKey, "Checked the returned text against the expected uppercase output.",
  )));
  assert.equal(acceptance.kind, 47007);
  assert.deepEqual(acceptance.tags.find(tag => tag[0] === "e"), ["e", result.id]);
  console.log(JSON.stringify({ request: request.id, result: result.id, acceptance: acceptance.id }));
} finally {
  relay.disconnect();
  requester.disconnect();
  worker.disconnect();
}
