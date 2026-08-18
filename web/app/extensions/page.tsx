export const revalidate = 60;

interface Count {
  skill_name: string;
  listing_author: string;
  installs: number;
}

async function topDownloads(): Promise<Count[]> {
  try {
    const res = await fetch('https://oxspgofacphchtuduaum.supabase.co/functions/v1/skill-installs', {
      next: { revalidate: 60 },
    });
    const body = (await res.json()) as { counts?: Count[] };
    return (body.counts ?? []).sort((a, b) => b.installs - a.installs);
  } catch {
    return [];
  }
}

function label(name: string): { display: string; kind: string } {
  if (name.startsWith('persona:')) return { display: `@${name.slice(8)}`, kind: 'agent' };
  return { display: name, kind: 'skill' };
}

export default async function ExtensionsPage() {
  const counts = await topDownloads();
  return (
    <div className="min-h-screen bg-black font-mono text-neutral-300">
      <div className="mx-auto w-full max-w-2xl px-6 py-16">
        <header className="mb-12 flex items-center justify-between text-sm">
          <a href="/" className="font-bold text-white">
            fez<span className="text-[#FF6A00]">▴</span>
          </a>
          <nav className="flex gap-6 text-neutral-500">
            <a href="/docs" className="transition-colors hover:text-white">docs</a>
          </nav>
        </header>
        <h1 className="text-2xl font-bold text-white">top downloads</h1>
        <p className="mt-2 text-sm text-neutral-500">
          every install is a signed receipt; a count is distinct installer keys — one key can never inflate it.
          global across relays.
        </p>
        <div className="mt-10 space-y-3">
          {counts.length === 0 && <p className="text-sm text-neutral-600">nothing counted yet.</p>}
          {counts.map((count, index) => {
            const { display, kind } = label(count.skill_name);
            return (
              <div
                key={`${count.skill_name}:${count.listing_author}`}
                className="flex items-center gap-4 rounded border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
              >
                <span className="w-6 text-right text-neutral-600">{index + 1}</span>
                <span className="font-bold text-white">{display}</span>
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">{kind}</span>
                <span className="ml-auto text-neutral-400">
                  ⇩ {count.installs} install{count.installs === 1 ? '' : 's'}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-10 text-xs text-neutral-600">
          install from the fez app: ⊞ extensions — or <code className="text-neutral-500">fez skill install &lt;name&gt;</code>
        </p>
      </div>
    </div>
  );
}
