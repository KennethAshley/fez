import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { createSubmission } from "../dist/miner.js";

// Fresh Node ESM process, built artifact, public development key; no live I/O.
await cryptoWaitReady();
const pair = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
let verified = false;
const submission = createSubmission({
  exec: async (_file, args) => {
    if (args[0] === "network") return { code: 0, stdout: "network: test\nendpoint: wss://test.finney.opentensor.ai:443\n" };
    if (args[0] === "metagraph") return { code: 0, stdout: "{}" };
    assert.deepEqual(args, ["export-hotkey", "quill", "--existing", "--json"]);
    return { code: 0, stdout: JSON.stringify({ persona: "quill", created: false, ss58Address: pair.address, keyfile: { secretPhrase: "//Alice" } }) };
  },
  fetch: async (url, init) => {
    assert.equal(url, "https://stg.numinous.earth/api/v3/miner/agents?limit=100&offset=0");
    assert.equal(init.method, "GET");
    const h = new Headers(init.headers);
    verified = signatureVerify(h.get("X-Payload"), Buffer.from(h.get("Authorization").slice(7), "base64"), pair.publicKey).isValid;
    assert.equal(verified, true);
    return Response.json({ items: [], total_count: 0 });
  },
});
const result = await submission.status({ persona: "quill", walletBin: "/fake/wallet", workDir: "/unused", config: {} });
assert.equal(result.phase, "not-submitted");
assert.equal(verified, true);
const baseline = await readFile(new URL("../examples/agent.py", import.meta.url));
assert.equal(createHash("sha256").update(baseline).digest("hex"), "9bf54fd0321ca770e8ed06f7aa6f656afaaba4de7a397d28f12ae0a9096b38ab");
console.log("PASS: built ESM initializes SR25519 and signs status; shipped upstream baseline hash matches. No live wallet or HTTP.");
