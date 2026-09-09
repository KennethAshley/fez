'use client';

import { useEffect, useState } from 'react';

/**
 * The one REAL number on a staged page: settlement fees bought-and-burned
 * as alpha, read live from the market relay in the visitor's own browser
 * (kind 47040, memo "burn" — published by fez-wallet's burn run, each
 * carrying the on-chain tx hash). No backend, same claim the public board
 * makes: nothing sits between the reader and the events.
 *
 * Renders nothing until the relay answers — a staged page must not show
 * a zero that reads as "the mechanism is fake too".
 */
export function BurnCounter() {
  const [burn, setBurn] = useState<{ tao: number; count: number }>();

  useEffect(() => {
    const seen = new Set<string>();
    let tao = 0;
    let alive = true;
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket('wss://bazaar.fez.chat');
    } catch {
      return; // no relay, no counter — never a fake number
    }
    ws.onopen = () => ws?.send(JSON.stringify(['REQ', 'burns', { kinds: [47040], limit: 500 }]));
    ws.onmessage = (m) => {
      if (!alive) return;
      let msg: unknown[];
      try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
      if (msg[0] !== 'EVENT') return;
      const ev = msg[2] as { id?: string; content?: string; tags?: string[][] };
      if (ev.content !== 'burn' || !ev.id || seen.has(ev.id)) return;
      const raw = ev.tags?.find((t) => t[0] === 'amount')?.[1];
      if (!raw || !/^\d+$/.test(raw)) return;
      seen.add(ev.id);
      tao += Number(raw) / 1e9;
      setBurn({ tao, count: seen.size });
    };
    return () => { alive = false; try { ws?.close(); } catch { /* closing */ } };
  }, []);

  if (!burn) return null;
  return (
    <div className="mt-6 border border-neutral-900 px-4 py-3 text-center">
      <div className="text-[0.68rem] uppercase tracking-[0.18em] text-neutral-600">
        live from the chain — not staged
      </div>
      <div className="mt-1 text-neutral-300">
        <span className="text-[#FF6A00]">{burn.tao.toFixed(4)} tTAO</span> of settlement fees
        bought &amp; burned as alpha
        <span className="text-neutral-600"> · {burn.count} burn{burn.count === 1 ? '' : 's'}</span>
      </div>
      <div className="mt-1 text-[10px] text-neutral-700">
        a 2% fee on every hire buys the subnet&apos;s token from its own pool and destroys it —
        each burn is a signed receipt with an on-chain tx
      </div>
    </div>
  );
}
