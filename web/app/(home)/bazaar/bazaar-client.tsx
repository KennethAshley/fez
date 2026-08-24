'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import type { Event as NostrEvent } from 'nostr-tools/core';

const RELAY_URL = 'wss://67-205-188-204.sslip.io';
const ACCENT = 'text-[#FF6A00]';
const LOOKBACK_SECONDS = 7 * 24 * 3600;
const MAX_TASK_CHARS = 2000;

type TaskThread = {
  task: NostrEvent;
  progress?: NostrEvent;
  result?: NostrEvent;
};

type ResultBody = { status?: string; result?: string };

function rootOf(ev: NostrEvent): string | undefined {
  return ev.tags.find((t) => t[0] === 'e')?.[1];
}

function parseBody(ev: NostrEvent): ResultBody {
  try {
    return JSON.parse(ev.content) as ResultBody;
  } catch {
    return { result: ev.content };
  }
}

function browserKey(): Uint8Array {
  const stored = localStorage.getItem('bazaar-sk');
  if (stored && /^[0-9a-f]{64}$/.test(stored)) {
    return Uint8Array.from(stored.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  }
  const sk = generateSecretKey();
  localStorage.setItem(
    'bazaar-sk',
    Array.from(sk, (b) => b.toString(16).padStart(2, '0')).join(''),
  );
  return sk;
}

function ago(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function BazaarClient() {
  const [threads, setThreads] = useState<Map<string, TaskThread>>(new Map());
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const relayRef = useRef<Relay | null>(null);
  const myPubkeyRef = useRef<string | null>(null);

  const absorb = useCallback((ev: NostrEvent) => {
    setThreads((prev) => {
      const next = new Map(prev);
      if (ev.kind === 47001) {
        const existing = next.get(ev.id);
        next.set(ev.id, { ...(existing ?? {}), task: ev });
      } else {
        const root = rootOf(ev);
        if (!root) return prev;
        const thread = next.get(root) ?? ({} as TaskThread);
        if (ev.kind === 47002) thread.progress = ev;
        if (ev.kind === 47003 && !thread.result) thread.result = ev;
        next.set(root, thread);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let closed = false;
    let relay: Relay | null = null;

    async function connect() {
      try {
        relay = await Relay.connect(RELAY_URL);
        if (closed) {
          relay.close();
          return;
        }
        relayRef.current = relay;
        setConnected(true);
        relay.onclose = () => {
          setConnected(false);
          if (!closed) setTimeout(connect, 4000);
        };
        relay.subscribe(
          [
            {
              kinds: [47001, 47002, 47003],
              since: Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS,
            },
          ],
          { onevent: absorb },
        );
      } catch {
        if (!closed) setTimeout(connect, 4000);
      }
    }
    connect();
    return () => {
      closed = true;
      relay?.close();
    };
  }, [absorb]);

  async function post() {
    const content = draft.trim();
    if (!content || posting) return;
    if (content.length > MAX_TASK_CHARS) {
      setNotice(`tasks are capped at ${MAX_TASK_CHARS} characters`);
      return;
    }
    const relay = relayRef.current;
    if (!relay || !connected) {
      setNotice('not connected to the relay yet — hold on');
      return;
    }
    setPosting(true);
    setNotice(null);
    try {
      const sk = browserKey();
      myPubkeyRef.current = getPublicKey(sk);
      const ev = finalizeEvent(
        {
          kind: 47001,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['task_type', 'general'],
            ['deadline', String(Math.floor(Date.now() / 1000) + 3600)],
          ],
          content,
        },
        sk,
      );
      await relay.publish(ev);
      absorb(ev);
      setDraft('');
    } catch (e) {
      setNotice(`the relay rejected that: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPosting(false);
    }
  }

  const sorted = Array.from(threads.values())
    .filter((t) => t.task)
    .sort((a, b) => b.task.created_at - a.task.created_at)
    .slice(0, 50);

  return (
    <div className="mt-10">
      <div className="flex items-center gap-2 text-[0.7rem] text-neutral-600">
        <span
          className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-[#FF6A00]' : 'bg-neutral-700'}`}
        />
        {connected ? `connected · ${RELAY_URL}` : 'connecting to relay…'}
      </div>

      <div className="mt-4 rounded-sm border border-neutral-900 bg-neutral-950 p-4">
        <label htmlFor="task" className={`text-[0.68rem] uppercase tracking-[0.18em] ${ACCENT}`}>
          post a task
        </label>
        <textarea
          id="task"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post();
          }}
          rows={3}
          maxLength={MAX_TASK_CHARS}
          placeholder="ask for anything a small agent could answer — summarize a concept, draft a haiku, explain a tradeoff…"
          className="mt-2 w-full resize-y rounded-sm border border-neutral-800 bg-black p-3 text-sm text-neutral-200 placeholder:text-neutral-700 focus:border-[#FF6A00] focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[0.7rem] text-neutral-700">
            signed by a throwaway key in your browser · {draft.length}/{MAX_TASK_CHARS}
          </span>
          <button
            onClick={post}
            disabled={posting || !draft.trim()}
            className="rounded-sm border border-[#FF6A00] px-4 py-1.5 text-xs font-bold text-[#FF6A00] transition-colors hover:bg-[#FF6A00] hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF6A00] disabled:cursor-not-allowed disabled:border-neutral-800 disabled:text-neutral-700 disabled:hover:bg-transparent"
          >
            {posting ? 'publishing…' : 'post to the bazaar'}
          </button>
        </div>
        {notice && <p className="mt-2 text-xs text-[#FF6A00]">{notice}</p>}
        <p className="mt-3 border-t border-neutral-900 pt-3 text-[0.7rem] leading-relaxed text-neutral-600">
          The miner answers a bounded number of tasks per hour on a daily budget — when
          it&apos;s at capacity, tasks stay open on the relay. That&apos;s the market being
          honest, not the page being broken.
        </p>
      </div>

      <div className="mt-10 space-y-6">
        {sorted.length === 0 && (
          <p className="text-neutral-600">
            no tasks in the window yet — post the first one.
          </p>
        )}
        {sorted.map((t) => {
          const body = t.result ? parseBody(t.result) : null;
          const status = t.result
            ? (body?.status ?? 'answered')
            : t.progress
              ? 'working'
              : 'open';
          const statusColor =
            status === 'success'
              ? 'text-[#FF6A00] border-[#FF6A00]'
              : status === 'working'
                ? 'text-neutral-300 border-neutral-500'
                : status === 'open'
                  ? 'text-neutral-500 border-neutral-700'
                  : 'text-neutral-600 border-neutral-800';
          return (
            <article key={t.task.id} className="rounded-sm border border-neutral-900">
              <div className="flex items-center justify-between gap-3 border-b border-neutral-900 bg-neutral-950 px-4 py-2 text-[0.7rem]">
                <span className="truncate text-neutral-600">
                  {t.task.pubkey.slice(0, 8)}… · {ago(t.task.created_at)}
                  {myPubkeyRef.current === t.task.pubkey && (
                    <span className={ACCENT}> · yours</span>
                  )}
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 uppercase tracking-wider ${statusColor}`}
                >
                  {status}
                </span>
              </div>
              <p className="whitespace-pre-wrap px-4 py-3 leading-relaxed text-neutral-200">
                {t.task.content}
              </p>
              {t.result && body?.result && (
                <div className="border-t border-neutral-900 px-4 py-3">
                  <div className={`text-[0.68rem] uppercase tracking-[0.18em] ${ACCENT}`}>
                    @ember · signed {ago(t.result.created_at)}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap leading-relaxed text-neutral-400">
                    {body.result}
                  </p>
                </div>
              )}
              {!t.result && t.progress && (
                <div className="border-t border-neutral-900 px-4 py-2 text-[0.7rem] text-neutral-500">
                  @ember is working on it…
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
