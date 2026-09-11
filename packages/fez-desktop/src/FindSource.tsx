import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { compact } from "./format";
import { parseSkillSource } from "@fezchat/client";

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
  /** Weekly installs — undefined until the second fetch lands, null if it failed. */
  downloads?: number | null;
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

/**
 * Weekly installs, one request per package.
 *
 * GitHub stars would be the intuitive thing to sort on, but npm's search
 * index doesn't carry them — they'd need a GitHub API call per result,
 * against a rate limit, and only for packages that even name a repo.
 * Downloads are the better signal anyway for the decision being made
 * here: stars measure how many people liked a page, installs measure how
 * many people actually run the thing. The gap is decisive in practice —
 * @brave/brave-search-mcp-server pulls ~14k/week against ~1k for its
 * nearest namesake.
 *
 * The bulk endpoint refuses scoped packages, and half of these are
 * scoped, so it's one call each. Failures resolve to null and the row
 * simply says nothing rather than implying zero.
 */
async function fetchDownloads(names: string[], signal: AbortSignal): Promise<Map<string, number | null>> {
  const entries = await Promise.all(
    names.map(async (name): Promise<[string, number | null]> => {
      try {
        const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${name}`, { signal });
        if (!res.ok) return [name, null];
        const body = (await res.json()) as { downloads?: number };
        return [name, typeof body.downloads === "number" ? body.downloads : null];
      } catch {
        return [name, null];
      }
    })
  );
  return new Map(entries);
}


export default function FindSource({
  skill,
  agent,
  onPick,
  onCancel,
}: {
  skill: string;
  agent?: string;
  /** (sourceSpec, provenance) — the caller resolves and renders it before anything runs. */
  onPick: (source: string, provenance: string) => void;
  onCancel: () => void;
}) {
  // Biased toward MCP servers, because that is what a skill is. Fully
  // editable: the name in the persona is a guess about the query too.
  const [query, setQuery] = useState(skill ? `${skill} mcp` : "mcp server");
  const [hits, setHits] = useState<NpmHit[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<"downloads" | "relevance">("downloads");

  const run = useCallback((text: string, signal: AbortSignal) => {
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    searchNpm(text, signal)
      .then((results) => {
        // Render on the search alone, then fill installs in — a second
        // round trip per result shouldn't hold the list hostage.
        setHits(results);
        setBusy(false);
        return fetchDownloads(results.map((hit) => hit.name), signal).then((counts) => {
          if (signal.aborted) return;
          setHits(results.map((hit) => ({ ...hit, downloads: counts.get(hit.name) ?? null })));
        });
      })
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

  /**
   * Sorting is stable and never drops a row: a package whose install
   * count failed to load sinks rather than vanishing, because "npm's
   * downloads endpoint hiccuped" must not look like "this package
   * doesn't exist".
   */
  const ranked = useMemo(() => {
    if (sort === "relevance") return hits ?? [];
    return [...(hits ?? [])].sort((a, b) => (b.downloads ?? -1) - (a.downloads ?? -1));
  }, [hits, sort]);

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="search-box install-box find-box" role="dialog" aria-modal="true" aria-label="Search MCP packages" onMouseDown={(e) => e.stopPropagation()} onKeyDown={e => { if (e.key === "Escape") onCancel(); }}>
        <div className="install-head">{agent ? `Find a package for ${skill}` : "Search MCP packages"}</div>
        <div className="settings-hint">
          {agent && <>@{agent} needs <strong>{skill}</strong>, but its setup does not specify a package. </>}
          These results come from npm. Check the publisher and package details before choosing; Fez has not verified these tools.
        </div>

        <div className="find-search">
          <input
            className="manage-input"
            aria-label="Search MCP packages"
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
        <div className="find-sort">
          <span>sort</span>
          {(["downloads", "relevance"] as const).map((key) => (
            <button
              key={key}
              className={sort === key ? "ext-filter active" : "ext-filter"}
              onClick={() => setSort(key)}
              title={key === "downloads" ? "weekly installs from npm — how many people actually run it" : "npm's own search ranking"}
            >
              {key === "downloads" ? "installs" : key}
            </button>
          ))}
        </div>

        {busy && <div className="pane-empty">searching npm…</div>}
        {error && <div className="ob-error">{error}</div>}
        {hits && !busy && hits.length === 0 && (
          <div className="pane-empty">
            nothing on npm for that — try different words.
          </div>
        )}

        <div className="find-results">
          {ranked.map((hit) => (
            <div key={hit.name} className="find-hit">
              <div className="skill-main">
                <span className="skill-name">
                  {hit.name}
                  {hit.version && <span className="role-tag">{hit.version}</span>}
                  {typeof hit.downloads === "number" && (
                    <span className="find-installs" title={`${hit.downloads.toLocaleString()} installs in the last week`}>
                      ⇩ {compact(hit.downloads)}/wk
                    </span>
                  )}
                </span>
                {hit.description && <span className="skill-desc">{hit.description}</span>}
                <span className="skill-author">
                  {/* Publisher and install count together are what
                      separate an official package from a fork of it —
                      the fork usually copies the description verbatim,
                      so the description tells you nothing. */}
                  published by <strong>{hit.publisher ?? "unknown"}</strong>
                  <button className="skill-link" onClick={() => void openUrl(hit.npmUrl)}>read it on npm</button>
                </span>
              </div>
              <div className="skill-actions">
                <button
                  className="agent-action"
                  disabled={!parseSkillSource(`npm:${hit.name}`)}
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
