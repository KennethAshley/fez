# Local mesh prototype

For the reusable two-machine provider with saved identity, start/stop commands,
and a real file-task check, see [Fez Mini model provider](../../../packages/fez-mesh/README.md).

Run from the Fez repository root:

```sh
node dev/experiments/mesh/run.mjs
```

This is an isolated experiment, not an installed extension or a GPU inference
engine. It starts a real Fez relay, a model host, and a caller gateway on separate
loopback ports. The default model is **simulated**. It proves the transport and
access checks; it does not demonstrate GPU sharing or model quality.

The caller gateway signs model requests with a temporary agent's Nostr key.
The host verifies the URL, method, body hash, timestamp and signature, rejects
replay, and checks the owner-signed roster and bans using Fez's existing
`WorkspaceState`. Each call requires a complete fresh relay read. Removing a
member blocks its next call; an already-running response is allowed to finish.
Only membership events reach the relay; prompts go directly to the model host.

If `~/.fez/bin/pi` exists, the demo also runs that real agent harness against the
gateway with isolated configuration, no tools, and no private context. Supply
`--pi /absolute/path/to/pi` for another installation. The terminal explicitly
reports when that check is skipped. Successful transport with the simulated
model is not a real model-inference result.

All identities are generated for the run. No existing workspace, keychain,
persona or provider configuration is changed. Listeners and temporary files
are cleaned up at exit. No dependencies or models are downloaded.

## Try a real model

Start an OpenAI-compatible model server separately, then supply its loopback
API base and exact model ID:

```sh
node dev/experiments/mesh/run.mjs --upstream http://127.0.0.1:11434/v1 --model YOUR_LOADED_MODEL
```

The upstream must accept unauthenticated local requests. The demo makes one
small ordinary completion and, when pi is available, one streaming agent turn.
It grants no tools to that agent. The serving process can see the prompts.
Zero costs in the temporary pi config are display placeholders, not measured
costs. Configure the upstream for an 8,192-token context; the temporary pi
provider advertises that window and caps output at 128 tokens. pi reserves
4,096 context tokens, so advertising only 4,096 leaves a one-token output
allowance even for a tiny prompt.

## Verified real run — September 18, 2026

The same demo passed with [Qwen2.5-0.5B-Instruct Q4_K_M](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF)
served by [llama.cpp b10964 / v0.4.1](https://github.com/ggml-org/llama.cpp/releases/tag/b10964)
on this Mac's Apple M4 Pro. Server logs confirmed all 25 layers were offloaded
to the Metal GPU. Both the ordinary request and the real bundled pi streaming
turn returned `LOCAL_MESH_OK`. The stranger, removal and relay-privacy checks
also passed. This establishes single-machine inference through the gateway;
it is not a model-quality benchmark. The two-machine test is recorded below.

The runtime and model were downloaded separately to
`/tmp/fez-mesh-real-f2EBb4`, with SHA-256 verified against the publishers:

- Runtime archive: `033c845c1df9bf945ff37bb193238b40910b2244be3e1e637b2ceb5878f1a6f5`.
- Model revision: `9217f5db79a29953eb74d5343926648285ec7e67`.
- Model file: `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`.

To repeat on this Mac while those temporary downloads remain, start the model:

```sh
/tmp/fez-mesh-real-f2EBb4/llama-b10964/llama-server \
  -m /tmp/fez-mesh-real-f2EBb4/qwen2.5-0.5b-instruct-q4_k_m.gguf \
  --alias fez-mesh-qwen --host 127.0.0.1 --port 18089 \
  -c 8192 -np 1 -ngl 99 --jinja --no-ui --cors-origins localhost
```

In another terminal, run:

```sh
node dev/experiments/mesh/run.mjs --upstream http://127.0.0.1:18089/v1 --model fez-mesh-qwen
```

Stop the model with Ctrl-C afterward. The demo's temporary gateway and relay
close automatically. The regression suite also exercises the installed pi
binary when available, checking its actual outgoing token allowance; that
one test is skipped on machines without bundled pi.

## Verified two-machine run — September 18, 2026

A second run used `kenmini.local` (Apple M4, 16 GiB, Node 24.16.0) as the
provider and this MacBook Pro as the caller. The same verified runtime and
model were copied to a temporary directory on the Mini. Its server logs
confirmed all 25 layers were offloaded to the Metal GPU.

The Mini ran the model, mesh host and temporary Fez relay. The MacBook ran
the signing gateway and its real bundled pi. An SSH tunnel with strict saved
host-key verification carried the requests; all HTTP listeners stayed on
loopback. The forwarded port matched the host port so the signed NIP-98 URL
and HTTP Host header remained identical. The Mini enforced the roster on
each request. The temporary agent's private key stayed on the MacBook, and
the temporary workspace owner's key stayed on the Mini.

The temporary test harness bundled the existing `mesh.ts` and Fez relay;
no protocol changes were needed. Its assertions passed:

- Ordinary inference and the real pi streaming turn returned `LOCAL_MESH_OK`.
- The Mini rejected a replay with HTTP 401 and a stranger with HTTP 403.
- Removing the agent from the Mini's roster blocked its next request with HTTP 403.
- The Mini's relay held membership events only, with no model prompt.

The harness exited successfully, and its relay, gateway, SSH tunnel and
model server were stopped. Runtime/model downloads remain in temporary
storage for another run. This proves inference sharing between two Macs
with access enforced at the provider. Provider identity and encrypted
transport came from SSH; automatic discovery and unattended hosting remain
outside this experiment.

## Checks

```sh
npm run evals -- --run tests/mesh-prototype.test.ts
npx tsc --noEmit --strict --skipLibCheck --target ES2022 --lib ES2022 --module NodeNext --moduleResolution NodeNext dev/experiments/mesh/mesh.ts dev/experiments/mesh/demo.ts
```

The prototype deliberately rejects non-loopback URLs. The two-machine test
uses SSH for encrypted transport and provider authentication. The reusable
provider adds persistent process lifecycle and request limits; protected
discovery remains outside this pilot.
There is no model sharding, automatic discovery, billing, or Bazaar change here.
