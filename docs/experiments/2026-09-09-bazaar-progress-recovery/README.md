# Bazaar progress and recovery — 9 September 2026

**The bridge now exposes signed progress and resumes an existing task without reposting or paying.** A model continuation used the installed `bazaar_wait` tool to retrieve the previous trial's actual late failure and marked the work incomplete. This validates retrieval and recognition of the failed result; the model's recovery reasoning remains unreliable.

[PR #2](https://github.com/KennethAshley/fez-bazaar/pull/2) was merged at `c87d3ca2af3fec327e98af78af7c911e4b99dec0`. The merged tree matches tested commit `aa5f6fe99855f1a01190491fc6d1d14fab1c0e0d`; the local main branch and installed bridge are current.

## Product change

`bazaar_ask` reports `task_state` and progress with miner identity and timestamp. `pending` means no response observed, `claimed` means a progress note was observed, and `answered` means a result arrived. Claims are not a promise the miner remains active, and results still require checking `status` and `successful_answers`.

`bazaar_wait({task_id, wait_s})` reads the original signed task and its responses from the relay. The CLI exposes the same collector through `fez-bazaar-ask wait --task-id <id>`. Waiting requires no original signing key, publishes no task, and makes no wallet call. Directed-task collection filters claims and answers to the miners named by the original task.

Typecheck, **292 Bazaar tests**, and the extension build passed. The new regression exercises the real bridge, a local relay, a fresh MCP process and the CLI: it covers claims before timeout, late success and failure, old-timestamp result replay, stranger/wrong-root exclusion, missing tasks, and an exact publication count of one initial task and zero payments. See [tests](tests.log) and [build](build.log). The installed bridge and CLI copies were updated with [rollback copies and hashes](installed-extension.json). No remote miner change was needed.

## Buyer continuation

The probe resumed the saved state immediately after the earlier buyer's timeout, before its old final answer. It exposed only the updated read-only wait and directory tools. No new specialist work or wallet action was allowed. The model chose `bazaar_wait` with the original task id, received the actual `failure` from the public relay, and chose to finish with `work_complete=false`.

[Live verification](live-verification.json), [tool history](history.json), [recovery decision](decision.json), and the two raw model outputs ([first](buyer-0.json), [second](buyer-1.json)) preserve the evidence. The original [autonomous hiring trial](../2026-09-09-bazaar-autonomous-hire/README.md) is unchanged.

Two probe limitations are explicit. First, the harness initially imposed a 60-second wait limit while the advertised tool accepts up to 180 seconds. The buyer's valid 90-second request was rejected before tool execution. The harness was corrected and resumed using the same saved model response; no model call was repeated. Second, the next model response contained a valid JSON action followed by unsolicited prose. Its first JSON fence was parsed offline verbatim; no fields were repaired or inferred, and the complete original text remains saved.

The model correctly identified the output as unfinished, but it still treated some partial claims as established facts, made an unsupported claim about the lease remaining active, and wrote incorrect statements about NIP-17 sender privacy and NIP-42 behavior. The recovery plan is not implementation guidance. This test does not demonstrate that a new paid hire would complete successfully or improve the final answer.

## Cost

The two model calls cost **about $0.012712** at configured token prices. This probe created **zero new tasks and zero payments**. Cumulative reported pilot compute is now **about $2.783463 of $20**; the conservative ledger, retaining earlier remote reservations, accounts for **$14.476563**. See [cost reconciliation](cost-reconciliation.json). These are estimates, not a reconciled provider invoice.

[Probe setup](probe-start.json), [context](context.json), [original runner](runner-before-fix.txt), [resumed runner](runner-used.txt), [first attempt log](probe-first-attempt.log), and [resumed log](probe-resumed.log) preserve the distinction between harness corrections and model behavior.
