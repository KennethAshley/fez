import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { viewerFor } from '@fezchat/artifact-viewers';
import './artifact.css';

/**
 * A shared artifact's public page. The event got here by explicit
 * re-publication (the share action POSTs the signed kind-40300 event to
 * /api/artifacts) — this page never reads a relay, so it can never leak
 * anything a workspace gates. The viewers are the same code the desktop
 * renders with (@fezchat/artifact-viewers).
 */

const UPSTREAM = 'https://oxspgofacphchtuduaum.supabase.co/functions/v1/shared-artifacts';
const HEX64 = /^[0-9a-f]{64}$/;

interface ArtifactBody {
  type?: string;
  title?: string;
  url?: string;
  content?: string;
}

async function fetchShared(id: string) {
  if (!HEX64.test(id)) return undefined;
  const res = await fetch(`${UPSTREAM}?id=${id}`, { next: { revalidate: 60 } });
  if (!res.ok) return undefined;
  const { event, sharedAt } = (await res.json()) as {
    event: { pubkey: string; created_at: number; content: string; tags: string[][] };
    sharedAt: string;
  };
  let body: ArtifactBody = {};
  try {
    body = JSON.parse(event.content) as ArtifactBody;
  } catch {
    body = { content: event.content };
  }
  const type = event.tags.find((t) => t[0] === 'type')?.[1] ?? body.type ?? 'unknown';
  return { event, sharedAt, body, type };
}

export async function generateMetadata(props: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await props.params;
  const shared = await fetchShared(id);
  const title = shared?.body.title ?? 'shared artifact';
  return {
    title: `${title} — fez`,
    description: 'An artifact shared from a fez workspace.',
  };
}

export default async function SharedArtifactPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const shared = await fetchShared(id);
  if (!shared) notFound();

  const { event, body, type } = shared;
  const Viewer = viewerFor(type);
  const artifact = { type, title: body.title, url: body.url, content: body.content };
  const author = `${event.pubkey.slice(0, 8)}…`;
  const when = new Date(event.created_at * 1000).toISOString().slice(0, 10);

  return (
    <div className="min-h-screen bg-black font-mono text-neutral-400 selection:bg-[#FF6A00] selection:text-black">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6">
        <header className="flex items-center justify-between border-b border-neutral-900 py-5 text-xs">
          <Link href="/" className="text-neutral-200 hover:text-[#FF6A00]">
            fez
          </Link>
          <span className="text-neutral-700">shared artifact</span>
        </header>

        <main className="flex-1 py-8">
          <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
            <span className="text-neutral-600">📦 {type}</span>
            {body.title && <h1 className="text-base text-neutral-100">{body.title}</h1>}
            <span className="text-neutral-700">
              by {author} · {when}
            </span>
          </div>

          {Viewer ? (
            <Viewer artifact={artifact} />
          ) : (
            <div className="rounded border border-neutral-800 p-6 text-sm">
              {body.url ? (
                <a href={body.url} className="text-[#FF6A00] underline" rel="noopener noreferrer">
                  open {body.title ?? type}
                </a>
              ) : (
                <span className="text-neutral-600">no viewer for “{type}”</span>
              )}
            </div>
          )}
        </main>

        <footer className="flex items-center justify-between border-t border-neutral-900 py-6 text-xs text-neutral-700">
          <span>
            made in a fez workspace<span className="text-[#FF6A00]">.</span>
          </span>
          <Link href="/" className="hover:text-[#FF6A00]">
            get fez →
          </Link>
        </footer>
      </div>
    </div>
  );
}
