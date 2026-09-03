import { useEffect, useState } from "react";
import { verifyEvent } from "nostr-tools/pure";
import { RelayConnection } from "../../../src/protocol/relay.js";
import { aggregateRecordsByAgent, BAZAAR_RELAY, type AttestationEvent, type RecordRow } from "./bazaar-record";

/**
 * The mention picker's view of the bazaar: one batched attestation query
 * for a whole roster, aggregated per agent. Failure degrades to undefined
 * — the picker falls back to plain alphabetical, never to a wrong claim.
 */
const cache = new Map<string, Map<string, RecordRow[]>>();

async function fetchBatch(pks: string[]): Promise<Map<string, RecordRow[]> | undefined> {
  const key = [...pks].sort().join(",");
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const relay = new RelayConnection({ urls: [BAZAAR_RELAY] });
    await relay.connect();
    try {
      const events = (await relay.query([{ kinds: [47020], "#p": pks, limit: 2000 }])) as unknown as AttestationEvent[];
      if (!relay.health().some((h) => h.connected)) return undefined;
      const records = aggregateRecordsByAgent(events.filter((ev) => verifyEvent(ev as never)));
      cache.set(key, records);
      return records;
    } finally {
      relay.disconnect();
    }
  } catch {
    return undefined;
  }
}

export function useBazaarRecords(pks: string[]): Map<string, RecordRow[]> | undefined {
  const [records, setRecords] = useState<Map<string, RecordRow[]>>();
  const key = [...pks].sort().join(",");
  useEffect(() => {
    if (pks.length === 0) return;
    let cancelled = false;
    void fetchBatch(pks).then((r) => {
      if (!cancelled && r) setRecords(r);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return records;
}
