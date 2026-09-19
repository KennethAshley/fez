# Fez Mini model provider

A single-provider extension: the Mac mini runs a model and checks Fez workspace
membership; this Mac's gateway signs requests as the agent using the model.
SSH pins the Mini's existing host key and encrypts the connection. All model,
gateway and relay listeners bind to loopback.

## Use the installed provider

In a desktop build containing the model-provider hook:

1. Open **Settings → Shared Models** to check the configured Mini or Start/Stop it.
2. Open **Agents → edit agent → model** and choose **Qwen3 4B · Mac mini**.
3. Save to grant that agent access. Restart a running agent to apply the change.

The picker entry is declared in `package.json` (`fez.modelProvider`): the desktop
runs `fez-mesh models --json` to list the model and `fez-mesh prepare --name
<persona> --model <id>` when you save, which connects the agent only while the
Mini is ready and the model on offer is the one selected. The settings panel
runs in its own isolated webview (`guiRuntime: "isolated"`).

The agent keeps its name, key, prompt and tools. Inference runs on the Mini;
tools run on this Mac. The settings card lists authorized agents and provides
**Revoke access**. The extension is independent of the Bazaar. Its `ui` and
`processes` permissions let it show settings and invoke its own `fez-mesh` CLI;
keys and per-agent credentials never enter the webview.

For a development install, build this package and run `fez link packages/fez-mesh`
from the repository root. The desktop and `fez-agent` must also include the
model-profile changes; installing this extension alone on an older Fez build
shows an update message. The host keeps the stable extension name `mesh`, with
the display label **Shared Models**.

```sh
~/.fez/bin/fez-mesh start
~/.fez/bin/fez-mesh status
~/.fez/bin/fez-mesh ask --file /absolute/path/to/task.txt
~/.fez/bin/fez-mesh stop
```

`start` loads the native macOS services. Check `status` after model loading;
it verifies the model, relay identity and the persona's signed access.
Closing the terminal leaves loaded services running. `stop` unloads both
machines' services. The pilot does not install automatic login startup.
Keep the Mini awake while using it.

`ask` runs the actual Fez evaluation runtime with the saved persona and a
separate pi profile containing only the Mini provider. It permits the persona's
normal tools; the evaluation directory is fresh, but is not an OS sandbox.
The command uses a 120-second task deadline and disables automatic model
retries. A failed or interrupted call must be retried explicitly. The model
cost fields are display placeholders and do not measure hardware or electricity
cost; a reported zero does not establish that running the model is free.

## What is installed

- Local configuration, isolated pi profile and launchd definition:
  `~/.fez/mesh/mini/`. The persona is `~/.fez/personas/mini-mesh.md`.
- Local keychain identities: `agent:mini-mesh` and `agent:mesh-mini-owner`.
  Neither private key is copied to the Mini.
- Mini configuration, runtime, model, persisted relay and service definitions:
  `~/.fez/mesh/mini/`. Its configuration pins the workspace owner's public key.
- The pilot gets a private model profile under `~/.fez/model-profiles/fez-mesh-mini/`
  (the layout fez-acp's `activateModelProfile` requires) and `modelProfile: fez-mesh-mini`
  in its persona; pi's global registry is not touched. Existing providers and defaults
  are preserved for the original CLI pilot.
- GUI-selected agents use provider `ext-mesh-mini` and a separate private profile
  at `~/.fez/model-profiles/ext-mesh-mini/<agent>/`. The profile binds the agent,
  provider and model. Missing or mismatched profiles stop startup. Model errors
  fail visibly without cloud fallback or automatic task replay.

`fez-mesh state --json` returns public status only. `connect --name <agent>`
grants the agent access and creates its private model profile; `disconnect
--name <agent>` revokes access. Gateway lookups and host membership checks run
for each request, so one agent's token cannot sign as another. A failed Save
leaves the persona unchanged, though a successful admission before a subsequent
disk-write failure can remain visible in the access list for manual revocation.

The Mini uses ports 18089 (model), 18090 (signed host) and 18092 (private relay).
The local gateway uses 18091; SSH forwards 18090 and 18092. Matching host ports
preserve NIP-98's signed URL and Host header.

The provider admits one inference at a time, returns HTTP 429 when busy,
caps output at 1,024 tokens per inference, and advertises a 16,384-token context. Membership
is read afresh for every request. A complete signed roster is required;
removing an agent blocks its next request, while an existing response can finish.
The persisted roster survives restart. Startup never adds a member.

```sh
~/.fez/bin/fez-mesh revoke AGENT_HEX_PUBKEY
~/.fez/bin/fez-mesh admit AGENT_HEX_PUBKEY
```

These commands require the workspace-owner key on this Mac and a running
SSH tunnel. Logs live at `~/.fez/mesh/mini/{gateway,host,model}.log` on the
machine running that component. A disconnected SSH process causes the gateway
to exit; launchd restarts it and reconnects. In-flight inference is never
replayed by the gateway.

## Build and verify

From the repository root:

```sh
npm run build --prefix packages/fez-mesh
npm run check --prefix packages/fez-mesh
npm run smoke --prefix packages/fez-mesh
npm run evals
```

The build bundles the existing Fez evaluation runtime beside the CLI. Its pi
trust entries use canonical paths and the active pi profile, so macOS temporary
directory aliases cannot silently discard the persona's model selection.

The live smoke test makes one agent invocation. It asks the persona to read a
synthetic request log, calculate totals using its tools and write a JSON report.
An independent assertion checks every output field. It retains its input,
prompt and report in the printed temporary directory, including on failure.
Transport success alone does not make this test pass.

## Verified installation — September 18, 2026

The provider on `kenmini.local` (Apple M4, 16 GiB) runs
[Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)
with the [Unsloth Q4_K_M quantization](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)
and [llama.cpp b10964](https://github.com/ggml-org/llama.cpp/releases/tag/b10964).
The server log confirmed all 37 layers offloaded to Metal. Downloads were
verified before loading:

- Model revision: `a06e946bb6b655725eafa393f4a9745d460374c9`.
- Model file: `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`.
- Model SHA-256: `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`.
- Runtime archive SHA-256: `033c845c1df9bf945ff37bb193238b40910b2244be3e1e637b2ceb5878f1a6f5`.

The live smoke task passed in 36.1 seconds: the actual Fez/pi agent read the
input, wrote and executed a Node.js program, and produced the correct six-field
report (6 requests, 3 successful, 2 denied, 1 busy, 120 successful output tokens,
1,000 ms mean successful duration). The independent assertion passed.
The full Fez gate passed 2,546 tests; 12 were skipped. Root, provider and ACP
typechecks passed.

Live lifecycle checks also passed: interrupting the gateway's SSH child caused
launchd to create a new gateway and restore access. Revoking the persona returned
HTTP 403 both before and after a full two-machine stop/start. Explicit owner
admission restored HTTP 200. The provider was left running and ready.

This is a narrow acceptance check, not evidence of general coding reliability.
An earlier freeform prompt produced the wrong average; explicitly requiring
program creation and execution produced the verified result. The earlier
Qwen3-4B model also failed this task. Keep independent checks around delegated
work and use small, explicit tasks with this 4B model.

This is a development package with GUI and CLI attachments. To recreate an installation,
create the host/client JSON profiles, initialize the two new identities through
`identity --name agent:<name>`, run `install-services` on each machine, start the
services, and explicitly admit the persona. Existing conflicting persona or
provider configuration is refused. Remote paths must be absolute and contain no
spaces or shell syntax; SSH uses `user@hostname` and existing known-host records.
No keys, cloud credentials or machine-specific private configuration belong in
the repository.

There is no automatic discovery, GPU sharding, billing or Bazaar-specific routing.
The serving machine can see prompts. The relay carries membership state; model
requests go through the direct SSH connection.
