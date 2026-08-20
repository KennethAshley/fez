import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * "@researcher wants web-search — what IS that?"
 *
 * The last resort, and deliberately the least automatic of the three
 * ways a missing skill becomes installable. A persona that declared its
 * source already answered this question; a relay listing is someone you
 * can name vouching for an answer. A bare name has neither, so fez asks
 * npm and hands the results to a person.
 *
 * It does not pick. It cannot: searching "web-search mcp" returns
 * packages from at least three unrelated publishers, and "brave-search"
 * returns Brave's own server next to a stranger's fork carrying a
 * byte-identical description. Auto-selecting the top hit would mean
 * running whoever won the search ranking that day. So the results are
 * shown with the one signal that actually distinguishes them — WHO
 * published it — and nothing installs until you choose and then read
 * the resolved command on the next screen.
 */

interface NpmHit {
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  date?: string;
  npmUrl: string;
}

/** npm's public search — the same index the website queries. */
async function searchNpm(query: string, signal: AbortSignal): Promise<NpmHit[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=15`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`npm search returned ${res.status}`);
  const body = (await res.json()) as {
    objects?: { package?: { name?: string; version?: string; description?: string; date?: string; publisher?: { username?: string }; links?: { npm?: string } } }[];
  };
  return (body.objects ?? [])
    .map((entry) => entry.package)
    .filter((pkg): pkg is NonNullable<typeof pkg> => !!pkg?.name)
    .map((pkg) => ({
      name: pkg.name!,
      version: pkg.version ?? "",
      description: pkg.description,
      publisher: pkg.publisher?.username,
      date: pkg.date,
      npmUrl: pkg.links?.npm ?? `https://www.npmjs.com/package/${pkg.name}`,
    }));
}

export default function FindSource({
  skill,
  agent,
  onPick,
  onCancel,
}: {
  skill: string;
  agent: string;
  /** (sourceSpec, provenance) — the caller resolves and renders it before anything runs. */
  onPick: (source: string, provenance: string) => void;
  onCancel: () => void;
}) {
  // Biased toward MCP servers, because that is what a skill is. Fully
  // editable: the name in the persona is a guess about the query too.
  const [query, setQuery] = useState(`${skill} mcp`);
  const [hits, setHits] = useState<NpmHit[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = useCallback((text: string, signal: AbortSignal) => {
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    searchNpm(text, signal)
      .then((results) => { setHits(results); setBusy(false); })
      .catch((err) => {
        if (signal.aborted) return;
        setError(String(err));
        setBusy(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    run(query, controller.signal);
    return () => controller.abort();
    // First load only — after that the search button drives it, so
    // typing doesn't fire a request per keystroke at npm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const search = () => {
    const controller = new AbortController();
    run(query, controller.signal);
  };

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="search-box install-box find-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="install-head">what is "{skill}"?</div>
        <div className="settings-hint">
          @{agent} declares <strong>{skill}</strong>, which is a nickname — its persona never said which package that is.
          These are npm search results. <strong>fez has not verified any of them</strong>: anyone may publish a package
          under any name, and forks routinely copy the original's description word for word. Check the publisher, read
          it on npm, then pick.
        </div>

        <div className="find-search">
          <input
            className="manage-input"
            value={query}
            autoFocus
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search();
              if (e.key === "Escape") onCancel();
            }}
          />
          <button className="mini" onClick={search} disabled={busy}>search</button>
        </div>

        {busy && <div className="pane-empty">searching npm…</div>}
        {error && <div className="ob-error">{error}</div>}
        {hits && !busy && hits.length === 0 && (
          <div className="pane-empty">
            nothing on npm for that. Try different words, or define it by hand: <code>fez skill add {skill} --command …</code>
          </div>
        )}

        <div className="find-results">
          {(hits ?? []).map((hit) => (
            <div key={hit.name} className="find-hit">
              <div className="skill-main">
                <span className="skill-name">
                  {hit.name}
                  {hit.version && <span className="role-tag">{hit.version}</span>}
                </span>
                {hit.description && <span className="skill-desc">{hit.description}</span>}
                <span className="skill-author">
                  {/* The only field here that separates the official
                      package from a fork of it. */}
                  published by <strong>{hit.publisher ?? "unknown"}</strong>
                  <button className="skill-link" onClick={() => void openUrl(hit.npmUrl)}>read it on npm</button>
                </span>
              </div>
              <div className="skill-actions">
                <button
                  className="agent-action"
                  onClick={() => onPick(`npm:${hit.name}`, `you picked this from npm search — published by ${hit.publisher ?? "an unknown account"}`)}
                >
                  use this…
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="agent-actions">
          <button className="agent-action" onClick={onCancel}>cancel</button>
        </div>
      </div>
    </div>
  );
}
