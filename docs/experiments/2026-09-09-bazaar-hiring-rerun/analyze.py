from pathlib import Path
import copy, hashlib, json, re

root = Path('/Users/ken/Projects/Fez/fez')
out = root / 'docs/experiments/2026-09-09-bazaar-hiring-rerun'
def read(name): return json.loads((out / name).read_text())
def save(name, value): (out / name).write_text(json.dumps(value, indent=2) + '\n')

scores = copy.deepcopy(read('scores.json'))
repairs = []
for row in scores:
    for index, verdict in enumerate(row['verdicts']):
        if 'result' in verdict: continue
        name = f"{row['case']}-judge-{index}.json"
        raw = read(name)
        if raw['stopReason'] != 'end': continue
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', raw['text'].strip())
        # Only the observed missing A-object and root-object braces. No scores
        # or words are inferred, and truncated responses remain unavailable.
        repaired = re.sub(r',\s*"b"\s*:\s*\{', '},"b":{', text, count=1) + '}'
        try: value = json.loads(repaired)
        except json.JSONDecodeError: continue
        assert set(value) == {'a', 'b'}
        for label in ['a', 'b']:
            assert len(value[label]['scores']) == 5
            assert all(type(x) is int and x in [0, 1, 2] for x in value[label]['scores'])
            assert isinstance(value[label]['reason'], str)
        repairs.append({'file': name, 'repair': 'Insert the missing closing brace before B and append the missing root closing brace; no content changes.', 'originalSha256': hashlib.sha256(raw['text'].encode()).hexdigest()})
        verdict['originalUnavailable'] = verdict.pop('unavailable')
        verdict['result'] = value
        verdict['recoveredMissingBraces'] = True
        for arm in ['solo', 'hire']:
            row[arm][index] = sum(value['a' if verdict['aArm'] == arm else 'b']['scores'])
save('scores-with-recorded-recovery.json', {'repairs': repairs, 'scores': scores})

ledger = read('ledger.json')
models = [x for x in ledger if x['type'] == 'model']
buyer_usd = sum(x['actualUsd'] for x in models if x['model'] == 'claude-haiku-4-5')
judge_usd = sum(x['actualUsd'] for x in models if x['model'] == 'claude-opus-5')
remote = []
log = (out / 'miner-cost-audit.txt').read_text()
for file in sorted(out.glob('*-specialist.json')):
    hire = json.loads(file.read_text())
    prefix = hire['task_id'][:8]
    matches = re.findall(r'^done ' + re.escape(prefix) + r' — (\w+); \$(\d+\.\d+) this task', log, re.M)
    assert len(matches) == 1, f'need one unique cost record for {prefix}'
    assert matches[0][0] == hire['answers'][0]['status']
    remote.append({'taskId': hire['task_id'], 'reportedUsd': float(matches[0][1]), 'precisionUsd': 0.0001, 'basis': 'miner usage priced by its configured model rates; log rounded to four decimals'})
remote_usd = sum(x['reportedUsd'] for x in remote)
carry = sum(x['actualUsd'] for x in ledger if x['type'] == 'carryover')
accounted = sum(x.get('actualUsd', x['reservedUsd']) for x in ledger)
total = carry + buyer_usd + judge_usd + remote_usd
assert accounted <= 20 and total <= accounted
assert len(models) == 18 and len(remote) == 2
assert all(x['state'] != 'reserved' for x in ledger)
save('cost-reconciliation.json', {
    'authorizedCumulativeUsd': 20, 'priorPilotUsd': carry, 'rerunBuyerUsd': buyer_usd,
    'rerunJudgeUsd': judge_usd, 'remoteTasks': remote, 'rerunRemoteReportedUsd': remote_usd,
    'rerunTotalReportedUsdApprox': buyer_usd + judge_usd + remote_usd,
    'cumulativeReportedUsdApprox': total, 'conservativeAccountedUsdIncludingUnreleasedReservations': accounted,
    'unusedBudgetAfterConservativeReservationsUsd': 20-accounted,
    'walletTransfers': 0, 'paidLeaseTested': False,
    'basis': 'Token-priced local usage plus rounded miner-side compute costs, not a reconciled provider invoice. Existing background validator/miner activity is outside this directed-request pilot. The two new $3 reservations remain held in the conservative ledger; prior $9 reservations were released only after server logs proved no model calls.'
})

labels = {'relay-trust':'Relay trust', 'private-workspace':'Private workspace', 'roster-ordering':'Roster ordering'}
table = []
rows = []
for row in scores:
    key = row['case']
    solo, hire = read(f'{key}-solo-arm.json'), read(f'{key}-hire-arm.json')
    outcome = {'relay-trust': 'Quill: lookup marker only', 'private-workspace': 'Quill: substantive analysis', 'roster-ordering': 'Buyer declined to hire'}[key]
    fmt = lambda xs: ' / '.join('unavailable' if x is None else str(x) for x in xs)
    table.append(f"| {labels[key]} | {outcome} | {solo['durationMs']/1000:.1f}s | {hire['durationMs']/1000:.1f}s | {fmt(row['solo'])} | {fmt(row['hire'])} |")
    rows.append({'case': key, 'outcome': outcome, 'soloSeconds': solo['durationMs']/1000, 'hireSeconds': hire['durationMs']/1000, 'soloWords':len(solo['final'].split()), 'hireWords':len(hire['final'].split()), 'soloScores':row['solo'], 'hireScores':row['hire']})
save('summary.json', {'cases':rows, 'realHires':2, 'signedReplies':2, 'substantiveSpecialistReplies':1, 'cumulativeReportedUsdApprox':total})

report = f'''# Bazaar hiring rerun — 9 September 2026

The availability fix is deployed. Both chosen hires returned signed replies; the first attempt had three timeouts. One reply was useful analysis and the other was only a lookup marker. Hiring improved one completed quality comparison, but this sample does not establish a reliable quality advantage or validate payments.

## Deployment verified

All four existing miners are active on the new binary, with the same daily caps: Ember $5, Quill $8, Forge $6, Drift $6. Signed announcements expose `acceptingWork`; the public board and desktop/MCP directory share the availability rule. Live HTML and JavaScript match the local files by SHA-256. The public board rendered four available miners.

The deployed Linux binary returned a signed `declined` result in **45 ms** under a $0 cap. This probe used a disposable identity, dummy API key and a private relay through SSH: no model calls or public canary events. See [deployed busy verification](deployed-busy-verification.json), [deployment verification](deployment-verification.json), [binary digest and service state](deployed-miner.txt), and [deployment log](deployment.log). The previous binary remains at `/opt/fez/fez-bazaar-miner.prev` for rollback.

## Experiment results

The same frozen tasks, source packet, rubrics, buyer/judge models and arm order were reused. Availability was re-read before each buyer decision; only specialists reporting `acceptingWork=true` were offered. Each arm used two buyer calls. All six final answers were generated anew. The buyer could choose one specialist or decline. This was a **free directed tryout, not a paid lease or wallet settlement**.

Scores are out of 10; pairs show the two blind display orders.

| Task | Hiring decision/result | Solo time | Hiring-arm time | Solo score | Hiring-arm score |
|---|---|---:|---:|---|---|
{chr(10).join(table)}

The relay-trust specialist returned only `[lookup 2] FETCH: https://raw.githubusercontent.com/nostr-protocol/nips/master/01.md`, yet labeled it `success`. That is a response arriving, not completed work. The final answer therefore cannot credit a specialist quality gain on that task.

The private-workspace hire supplied substantive analysis in 37.9 seconds. The completed judge comparison favored its final answer 9–7, particularly because it required the agent to authorize task senders independently of DM encryption. The reverse-order judgment was truncated, so the gain lacks that confirmation. My review agrees with the central error in the solo answer: being able to decrypt a message does not restrict who can send a task to the recipient.

For roster ordering, the buyer decided it could answer unaided. Both arms accepted the false premise that kind 47102 is addressable under NIP-01 despite its 30000–39999 range. Any score difference on this task reflects the buyer's prompts or sampling, not hiring.

The hired private-workspace final had 331 whitespace-delimited words and the no-hire roster final 310, exceeding the requested 300; the other finals were within it. This weakens the claim of equal output length.

## Scoring limits

Two reverse-order judge responses exhausted their output budgets and remain unavailable; no paid judge call was repeated. One complete response omitted both the closing brace before B and the final root brace. Those two braces were restored offline, with no scores or text inferred. [Recorded recovery and scores](scores-with-recorded-recovery.json) preserves that transformation and its source hash; [original scoring output](scores.json) remains unchanged. Other missing-brace recoveries are already flagged by the original runner. Three cases and one judge model are exploratory evidence, not a general performance estimate.

## Cost

- Prior pilot: **${carry:.6f}**. Server logs prove the three original remote requests were skipped before model calls; their $9 reservations were released. [Evidence](prior-remote-audit.txt).
- Rerun buyer: **${buyer_usd:.6f}**; judge: **${judge_usd:.6f}**; specialist compute reported by the miner: **${remote_usd:.4f}**.
- Both attempts combined: **about ${total:.2f}**, under the original **$20 total** authorization.
- Even retaining the new remote reservations, the conservative ledger accounts for **${accounted:.2f}**. No wallet transfers occurred.

These are token-priced usage and rounded miner-side costs, not a reconciled provider invoice. [Cost reconciliation](cost-reconciliation.json), [ledger](ledger.json), and [miner task-cost evidence](miner-cost-audit.txt) retain the distinction. Unrelated background market activity is excluded from the directed-request pilot.

## Next test

Add a completion check that rejects a tool marker or other unfinished output as a successful deliverable, and verify buyer recovery from that rejection. Then test an actual wallet-backed hire with payer/request identity continuity and a settlement receipt. The present test verifies discovery, choice and response delivery; it does not prove the paid economic loop.

## Artifacts and checks

[Preregistration](preregistered.json), [frozen sources](sources.json), [signed wire audit](wire-audit.json), [summary](summary.json), and the per-call JSON files preserve every decision, answer, prompt, failure and duration. The original failed-delivery run is unchanged in [the baseline folder](../2026-09-09-bazaar-hiring/README.md).

Fresh validation: 270 Bazaar tests passed during deployment; the Linux binary built. The pilot self-check and core typecheck passed. The Fez gate passed 1,403 tests with one skipped after the harness update. The live board was visually checked after deployment.
'''
(out/'README.md').write_text(report)
print(json.dumps({'cumulativeReportedUsdApprox': total, 'conservativeAccountedUsd': accounted, 'buyerUsd': buyer_usd, 'judgeUsd': judge_usd, 'remoteReportedUsd': remote_usd, 'offlineRepairs': repairs, 'cases': rows}, indent=2))
