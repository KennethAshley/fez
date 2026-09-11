// Throwaway testnet probe. Mirrors the official numi HTTP/signature contract.
// Keys stay in memory; no provider linking, treasury signing, or mainnet option.
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const r = createRequire(path.resolve(__dirname, '../../../packages/fez-wallet/package.json'));
const {Keyring} = r('@polkadot/keyring');
const {cryptoWaitReady, signatureVerify} = r('@polkadot/util-crypto');
const API = 'https://stg.numinous.earth';
const HOTKEY = '5Cd2Nvkmd3mjFz4LPyJo8P4v8ddiHQo1yabfX9Qzv7d1RBGc';
const WALLET = path.join(require('node:os').homedir(), '.fez/bin/fez-wallet');
const BASELINE_HASH = '9bf54fd0321ca770e8ed06f7aa6f656afaaba4de7a397d28f12ae0a9096b38ab';

function headers(pair, suffix) {
  const payload = `${pair.address}:${suffix}`;
  const signature = pair.sign(Buffer.from(payload));
  assert(signatureVerify(payload, signature, pair.publicKey).isValid);
  return {
    Authorization: `Bearer ${Buffer.from(signature).toString('base64')}`,
    'Miner-Public-Key': Buffer.from(pair.publicKey).toString('hex'),
    Miner: pair.address,
    'X-Payload': payload,
  };
}

function baseline(bytes) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), BASELINE_HASH,
    'Only the verified upstream baseline may be uploaded by this probe');
  const form = new FormData();
  form.append('agent_file', new Blob([bytes], {type:'text/x-python'}), 'hello_world.py');
  form.append('name', 'Fez drift testnet baseline');
  form.append('track', 'SIGNAL');
  return form;
}

async function request(pair, route, options={}) {
  assert(['/api/v3/miner/agents?limit=100&offset=0', '/api/v3/miner/services',
    '/api/v3/miner/upload_agent'].includes(route));
  const response = await fetch(API+route, {
    headers:headers(pair, Math.floor(Date.now()/1000)),
    ...options, redirect:'error', signal:AbortSignal.timeout(30000),
  });
  // Avoid printing request headers, auth signatures, or credential payloads on failures.
  if (!response.ok) throw Error(`Numinous test API returned HTTP ${response.status} for ${route}`);
  return response.json();
}

async function main() {
  const mode = process.argv[2] ?? 'status';
  assert(['status','upload','self-test'].includes(mode), 'Use status, upload, or self-test');
  await cryptoWaitReady();
  if (mode === 'self-test') {
    const pair = new Keyring({type:'sr25519'}).addFromUri('//Alice');
    const h = headers(pair, 'test-digest');
    assert.equal(h['X-Payload'], `${pair.address}:test-digest`);
    assert.equal(Buffer.from(h.Authorization.slice(7),'base64').length,64);
    assert.equal(h['Miner-Public-Key'], Buffer.from(pair.publicKey).toString('hex'));
    assert.throws(()=>baseline(Buffer.from('unreviewed code')));
    const bytes=readFileSync(path.join(__dirname,'upstream/hello_world.py'));
    const form=baseline(bytes);
    assert.equal(form.get('track'),'SIGNAL');
    assert.equal(form.get('agent_file').name,'hello_world.py');
    console.log('PASS: SR25519 payload/signature verified; SIGNAL form pinned; changed code refused');
    return;
  }
  const network=execFileSync(WALLET,['network'],{encoding:'utf8',timeout:15000});
  assert(network.includes('network: test') && network.includes('endpoint: wss://test.finney.opentensor.ai:443'), 'Testnet required');
  let exported;
  try {
    exported=JSON.parse(execFileSync(WALLET,['export-hotkey','drift','--json'],
      {encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}));
  } catch { throw Error('Could not load Drift hotkey; secret output suppressed'); }
  assert.equal(exported.created,false, 'Expected the existing Drift hotkey');
  assert.equal(exported.ss58Address,HOTKEY);
  const pair=new Keyring({type:'sr25519'}).addFromUri(exported.keyfile.secretPhrase);
  assert.equal(pair.address,HOTKEY);
  exported=null;
  const agents=await request(pair,'/api/v3/miner/agents?limit=100&offset=0');
  assert(Array.isArray(agents.items), 'Unexpected agent-list response');
  if (mode === 'upload') {
    assert(!agents.items.some(a=>a.track==='SIGNAL'), 'A SIGNAL agent already exists; inspect before replacing');
    const bytes=readFileSync(path.join(__dirname,'upstream/hello_world.py'));
    const result=await request(pair,'/api/v3/miner/upload_agent',{
      method:'POST', headers:headers(pair,BASELINE_HASH),body:baseline(bytes),
    });
    console.log(JSON.stringify({environment:'test',track:'SIGNAL',hotkey:HOTKEY,
      upload:result},null,2));
    return;
  }
  const services=await request(pair,'/api/v3/miner/services');
  assert(Array.isArray(services.credentials), 'Unexpected services response');
  console.log(JSON.stringify({environment:'test',hotkey:HOTKEY,
    agents:agents.items.map(a=>({versionId:a.version_id,name:a.agent_name,track:a.track,
      version:a.version_number,createdAt:a.created_at,activatedAt:a.activated_at})),
    linkedServices:services.credentials.map(s=>({name:s.service_name,track:s.track})),
  },null,2));
}

main().catch(e=>{console.error(e.message);process.exitCode=1});
