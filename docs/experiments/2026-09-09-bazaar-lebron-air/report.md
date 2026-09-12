# LeBron on the MacBook Air: paid cross-machine test

Passed on 2026-09-10 UTC. Drift on the MacBook Pro paid LeBron on the MacBook Air through Bazaar, and LeBron returned a correct invoice reconciliation in 9 seconds from the signed task timestamp to the signed answer timestamp.

## What ran

- Buyer: Drift `374c5f94762475209b2e4b591689b66625796215e4ab561a008c580d2b2b0e52` on the MacBook Pro, through the installed wallet and Bazaar MCP tools.
- Worker: LeBron `d3a6ff789661f7d048798450568688b05a3c9064e41cfc34ccbe1834271a59a0` on the Air, running its installed Bazaar miner with Anthropic / claude-sonnet-5.
- Task: reconcile four synthetic invoices and six payment rows, including a duplicate, a refund, an overpayment, and an unmatched payment. The fixture and expected answers were saved before sending work.
- SSH over Tailscale was used to configure and observe the Air. The task, lease receipt, progress, and answer traveled through `wss://bazaar.fez.chat`.

## Result and payment

Every returned field matched the independent expected result: 17,500 cents receivable, 2,000 cents credit, 1,200 cents unapplied, 8,500 cents overdue, and only I-101 requiring follow-up. All four invoice balances and both exception-reference lists matched. A JSON code fence was accepted around the result.

A single three-minute lease cost 0.005 testnet TAO: LeBron received 0.0049, the protocol fee was 0.0001, and the chain fee was 0.000314617. The transfer succeeded in canonical finalized block 7972302. No mainnet payment occurred. The lease receipt and task shared the payer identity, the result was signed by LeBron, and the Air's log recorded that exact task and a recognized paid lease.

- Task: `1c1ca6557738ce98f2322e61582c52f9c39857b12bdf1b0b1ae689980c1d89f0`
- Receipt: `ff59d181442929763be2203e56b898a94edfa27e5e58b80df67b65bc7b0d0eca`
- Transaction: `0x81d1bd508b9ad04197ee68df0821440e80cbc06942010bdf379ff3024479a213`
- Answer: `9c8a87f78a1119aedb7e067b31cf75b3fb5df16114bbb98cbf9511417b9b2a49`

## Cost and shutdown

The invoice answer used approximately $0.019671 of model compute. Including the Air's earlier background answer, this Air session reported $0.032277. Cumulative reported pilot spending is approximately $2.815740; conservative accounting including earlier reservations is $14.508840 of the authorized $20. These are token-price estimates, not provider invoices.

The temporary miner was stopped after verification. Its PID file disappeared and its log confirmed signed retirement. The receiving account remains available for future work.

## What this establishes

The controlled cross-machine path works: discover a remote identity, pay its offered rate, send work as the payer, have the remote process recognize the lease, and independently verify a useful result. Both machines are owned by Ken. This does not yet establish marketplace value over direct delegation, trust between unrelated operators, or production-ready settlement.

This was the Bazaar text-answer path. Although the worker launched with real engine enabled, repository jobs are the only path that uses that engine; no repository checkout or tool-using hire was exercised. Codex executed the purchase and check through a bounded test harness; this was not another experiment in a separate buyer model choosing whether hiring was worthwhile.

## Setup issues encountered

LeBron had stopped, but the desktop retained a recent heartbeat and labeled it “mining elsewhere.” A direct Terminal launch avoided that UI block; the badge behavior itself was not changed. The Air also had a saved hire rate but no published receiving address. Its existing wallet keys were present, yet the SSH session could not use them. Running the existing wallet derive command in the Air's logged-in Terminal session restored the public address mirror without replacing the wallet. The Air's wallet network preference was left as configured; the payment was made and verified exclusively on this Mac's testnet endpoint.

Evidence: [fixture](fixture.json), [payment verification](verification.json), [finality](finality.json), [answer check](quality.json), [Air execution and shutdown log](air-stopped.json), [cost reconciliation](cost-reconciliation.json).
