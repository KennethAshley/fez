// Local development-chain check. Reuses Fez's installed Polkadot dependencies.
// All RPC travels through docker exec over SSH; no public endpoint is accepted.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const load = createRequire(path.resolve(__dirname, '../../../packages/fez-wallet/package.json'));
const { ApiPromise, HttpProvider, Keyring } = load('@polkadot/api');
const { cryptoWaitReady } = load('@polkadot/util-crypto');
const host = process.env.HIPPIUS_TEST_SSH_HOST;
assert(host && /^[a-zA-Z0-9_.@-]+$/.test(host), 'Set HIPPIUS_TEST_SSH_HOST=user@host');

function remote(command, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command],
      { timeout: 25000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
    child.stdin.end(input);
  });
}

async function minerIdentity(message) {
  // Only the disposable storage trial's key is mounted. Its private bytes stay there.
  const command = `docker run --rm -i --network none --read-only --user 65534:65534 --cap-drop ALL --memory 128m --pids-limit 32 --mount type=volume,src=fez-hippius-lab_miner-data,dst=/data,readonly --entrypoint python fez-hippius-storage-test:0.1.32 -c 'import json,sys; from pathlib import Path; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey; key=Ed25519PrivateKey.from_private_bytes(Path("/data/miner/keypair.bin").read_bytes()); msg=sys.stdin.read().strip(); print(json.dumps({"public":key.public_key().public_bytes_raw().hex(),"signature":key.sign(bytes.fromhex(msg)).hex() if msg else None}))'`;
  return JSON.parse(await remote(command, message || ''));
}

async function main() {
  const info = JSON.parse(await remote('docker inspect fez-hippius-devchain-trial'))[0];
  assert(info.State.Running, 'Start the development chain first');
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert(info.Config.Cmd.includes('--chain=development'));
  assert(info.Config.Cmd.includes('--alice'));
  const provider = new HttpProvider('http://127.0.0.1:9944');
  provider.send = async (method, params) => {
    const raw = await remote('docker exec -i fez-hippius-devchain-trial curl --fail --silent --show-error --max-time 15 -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:9944',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    const result = JSON.parse(raw);
    if (result.error) throw new Error(JSON.stringify(result.error));
    return result.result;
  };
  assert.equal(await provider.send('system_chain', []), 'Development');
  const api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
  try {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });
    const alice = keyring.addFromUri('//Alice');
    const bob = keyring.addFromUri('//Bob');
    assert.equal((await api.query.sudo.key()).unwrap().toString(), alice.address);
    assert(api.tx.arion?.registerChild, 'Arion pallet missing');
    assert((await api.rpc.chain.getHeader()).number.toNumber() > 0, 'Chain is not producing blocks');

    async function submit(label, call, expectedError) {
      let nextBlock = (await api.rpc.chain.getHeader()).number.toNumber() + 1;
      const hash = await call.signAndSend(alice);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const head = (await api.rpc.chain.getHeader()).number.toNumber();
        while (nextBlock <= head) {
          const blockHash = await api.rpc.chain.getBlockHash(nextBlock++);
          const { block } = await api.rpc.chain.getBlock(blockHash);
          const index = block.extrinsics.findIndex(tx => tx.hash.eq(hash));
          if (index < 0) continue;
          const records = (await api.query.system.events.at(blockHash))
            .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.toNumber() === index);
          const failure = records.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
          if (expectedError) {
            assert(failure, `${label}: expected rejection`);
            const decoded = api.registry.findMetaError(failure.event.data[0].asModule);
            assert.equal(decoded.name, expectedError);
          } else {
            assert(!failure, `${label}: ${failure?.event.data.toString()}`);
            assert(records.some(({ event }) => api.events.system.ExtrinsicSuccess.is(event)));
            for (const { event } of records) {
              if (event.section === 'sudo' && event.method === 'Sudid') assert(event.data[0].isOk, 'Sudo inner call failed');
            }
          }
          console.log(`PASS: ${label} at block ${block.header.number} (${hash})`);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      throw new Error(`${label}: transaction inclusion timed out`);
    }

    const { public: nodeHex } = await minerIdentity();
    const nodeId = '0x' + nodeHex;
    assert((await api.query.arion.childRegistrations(bob.address)).isNone, 'Use a fresh disposable chain');
    // Sudo provisions only the development family prerequisite. This does not
    // claim the public network's coldkey eligibility checks have been satisfied.
    await submit('development family provisioned', api.tx.sudo.sudo(
      api.tx.registration.forceRegisterColdkeyNode(alice.address, 'StorageMiner', '0x' + Buffer.from('fez-offline-family').toString('hex'))));
    await submit('child authorized as proxy', api.tx.proxy.addProxy(bob.address, 'Any', 0));
    await submit('invalid miner signature rejected', api.tx.arion.registerChild(alice.address, bob.address, nodeId, '0x' + '00'.repeat(64)), 'InvalidNodeSignature');
    assert((await api.query.arion.childRegistrations(bob.address)).isNone);
    const nonce = await api.query.arion.nodeIdNonce(nodeId);
    const message = Buffer.concat([Buffer.from('ARION_NODE_REG_V1'), alice.publicKey, bob.publicKey,
      Buffer.from(nodeHex, 'hex'), api.createType('u64', nonce).toU8a()]);
    const { signature } = await minerIdentity(message.toString('hex'));
    await submit('storage miner registered in Arion', api.tx.arion.registerChild(alice.address, bob.address, nodeId, '0x' + signature));
    const registered = (await api.query.arion.childRegistrations(bob.address)).unwrap();
    assert.equal((await api.query.arion.nodeIdToChild(nodeId)).unwrap().toString(), bob.address);
    assert.equal((await api.query.arion.nodeIdNonce(nodeId)).toBigInt(), nonce.toBigInt() + 1n);
    console.log(JSON.stringify({ chain: 'Development', runtime: api.runtimeVersion.specVersion.toNumber(),
      genesis: api.genesisHash.toHex(), minerNodeId: nodeId, registration: registered.toJSON() }, null, 2));
    console.log('LOCAL TEST ONLY: family eligibility seeded by Alice sudo; no public validator or rewards tested');
  } finally { await api.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
