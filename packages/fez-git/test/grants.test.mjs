import test from "node:test";
import assert from "node:assert/strict";
import { parseGrants, grantActive, withGrant, withoutGrant } from "../dist/policy-test.mjs";

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);

test("grants round-trip, expire, and prune", () => {
  const now = 1_000_000;
  // add two grants
  let raw = withGrant(undefined, PK_A, now + 3600, now);
  raw = withGrant(raw, PK_B, now + 60, now);
  assert.equal(parseGrants(raw).size, 2);
  assert.ok(grantActive(raw, PK_A, now));
  assert.ok(grantActive(raw, PK_B, now));
  // B expires: inert immediately, without any owner action
  assert.ok(!grantActive(raw, PK_B, now + 61));
  assert.ok(grantActive(raw, PK_A, now + 61));
  // the next owner-signed edit prunes the expired entry
  const later = withGrant(raw, PK_A, now + 7200, now + 61);
  assert.equal(parseGrants(later).size, 1);
  // revoke kills a live grant now
  assert.equal(withoutGrant(later, PK_A, now + 61), "");
});

test("malformed entries are dropped, never fatal", () => {
  const grants = parseGrants(`junk ${PK_A}:notanumber :123 ${PK_B}:5000 short:99`);
  assert.equal(grants.size, 1);
  assert.equal(grants.get(PK_B), 5000);
  assert.ok(!grantActive(undefined, PK_A, 0));
  assert.ok(!grantActive("", undefined, 0));
});
