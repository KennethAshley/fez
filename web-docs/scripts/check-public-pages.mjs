import assert from 'node:assert/strict';

// Deployment smoke check: the docs domain previously served the marketing app.
const docs = 'https://docs.fez.chat';
for (const path of ['/', '/concepts/bazaar']) {
  const response = await fetch(`${docs}${path}`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${docs}${path} must resolve`);
  const html = await response.text();
  assert.ok(/href="\/concepts\/bazaar(?:["#?])/.test(html), 'manual navigation must include the Bazaar guide');
  if (path !== '/') {
    assert.ok(/coordination/i.test(html), 'the guide must describe coordination');
    assert.ok(/553/.test(html), 'the guide must identify the testnet subnet');
  }
  console.log(`PASS ${docs}${path}`);
}
