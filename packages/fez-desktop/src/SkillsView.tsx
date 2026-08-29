import { Component, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FezClient, WireEvent } from "@fezchat/client";
import { parseSkillSource, describeSkillSpec, wellKnownSource, machineLocalPath, resolveInstalledSkill, packageFromSource } from "@fezchat/client";
import type { BrowserWire } from "./wire";
import Avatar from "./Avatar";
import { EnvKeyStatus } from "./SkillSecrets";
import FindSource from "./FindSource";
import { ExtensionGallery } from "./ExtensionGallery";
import { flash } from "./toast";
import { useConfig, bumpConfig } from "./config-store";
import { attachSkill, detachSkill, declaredSkills, rememberSkillSource } from "./skill-attach";
import type { Dispose } from "./mount-result";

/**
 * Skills — the machine catalog + the decentralized marketplace.
 * Installed skills live in ~/.fez/settings.json (same file the CLI's
 * `fez skill add` writes); marketplace listings are signed 40200 events
 * on the relay. Installing is ALWAYS a local decision: the full command
 * renders verbatim before you accept, env keys are filled here and
 * never ride the wire. A listing is a recommendation from a pubkey —
 * nothing runs until you install it AND a persona declares it.
 *
 * A missing skill now has three ways to become installable, in trust
 * order — the persona said where it comes from; someone on the relay
 * signed a listing for it; or you searched npm and picked one yourself.
 * There is deliberately no fourth: fez never resolves a bare name on
 * your behalf, because "web-search" is an alias, not an identifier, and
 * npm has several unrelated packages answering to it.
 */

const KIND_SKILL_LISTING = 40200;
const KIND_SKILL_INSTALL = 40201;
/** Company-tier cross-relay install index — empty until fez company infra exists (infra/skill-counts is ready to deploy); relay receipts carry the counts meanwhile. */
const DEFAULT_COUNTS_URL = "https://fez.chat/api/counts";
const countsUrl = () => localStorage.getItem("fez-skill-counts-url") ?? DEFAULT_COUNTS_URL;

interface SkillConfig {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  env?: Record<string, string>;
  /** Install provenance (Task 2) — the portable `name=source` form for a persona that gains this skill. */
  source?: string;
  /** Canonical package id, so a persona declaring this package under ANY local name still resolves. */
  package?: string;
  /** One line for a picker (Task 5) — carried from the listing at install time. */
  description?: string;
}

interface Listing {
  name: string;
  artifact?: string;
  persona?: string;
  requiredSkills?: string[];
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  installCmd?: string;
  github?: string;
  npm?: string;
  homepage?: string;
  authorPk: string;
  ts: number;
}

/**
 * What the consent dialog is being asked to install, whatever produced
 * it. `authorPk` is what separates a relay listing (whose install count
 * gets a signed receipt) from a source you resolved yourself; `source`
 * + `rememberIn` are how a name you just pinned down gets written back
 * into the persona that declared it, so the next machine doesn't have
 * to guess either.
 */
interface InstallTarget {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  /** Set only for relay listings — publishing a receipt for anything else would credit a stranger. */
  authorPk?: string;
  /** Provenance, shown above the command: where this answer came from. */
  provenance: string;
  source?: string;
  rememberIn?: string;
  /** Carried into the written entry so the picker (Task 5) has a line to show. */
  description?: string;
}

/**
 * The three parts are PLACES, not kinds — the single most confusing
 * thing on this page. One npm package can be filed into all three:
 * fez-polls renders poll cards here, runs a tally service in the
 * background, AND hands agents a create_poll tool. Reading "gui" and
 * "skill" as two sorts of thing is what makes the page not parse.
 */
const PART_WHERE: Record<string, { where: string; what: string }> = {
  skill: { where: "settings.json → mcpServers", what: "your agents call it" },
  headless: { where: "~/.fez/extensions", what: "background work in the TUI" },
  gui: { where: "~/.fez/gui-extensions", what: "renders in this app" },
};

const fromListing = (listing: Listing): InstallTarget => ({
  name: listing.name,
  command: listing.command,
  args: listing.args,
  url: listing.url,
  envKeys: listing.envKeys,
  authorPk: listing.authorPk,
  provenance: "listed on your relay — a recommendation from a pubkey, not a guarantee",
  description: listing.description,
});

/**
 * Two audiences, one component.
 *
 * `only` splits what was a single page into the two settings sections it
 * always contained: SKILLS are definitions an agent can call (web-search,
 * github — most belong to no package at all), EXTENSIONS are packages,
 * one of whose parts may be a skill. Keeping one component means the
 * shared machinery — install consent, source resolution, the local-path
 * guard — cannot drift between them.
 */
export default function SkillsView({
  client,
  wire,
  only,
}: {
  client: FezClient;
  wire: BrowserWire;
  /** Undefined shows everything (the old standalone page). */
  only?: "skills" | "extensions";
}) {
  // Extensions open on browse — discovery first; skills open on what you have.
  const [tab, setTab] = useState<"installed" | "browse">(only === "extensions" ? "browse" : "installed");
  const [filter, setFilter] = useState<"all" | "agents" | "skills" | "packs">("all");
  // Skills (mcpServers) and installed parts come from the one config store —
  // reactive to installs/removes without a local fetch to keep in sync.
  const { skills: installed, localParts } = useConfig() as { skills: Record<string, SkillConfig>; localParts: Record<string, string[]> };
  const [listings, setListings] = useState<Listing[]>();
  const [installing, setInstalling] = useState<InstallTarget>();
  const [finding, setFinding] = useState<{ agent: string; skill: string }>();
  const [publishing, setPublishing] = useState<string>();
  const [installs, setInstalls] = useState<Map<string, number>>(new Map());
  const [copied, setCopied] = useState<string>();
  const [agentDeps, setAgentDeps] = useState<{ agent: string; skills: string[]; sources: Record<string, string> }[]>([]);
  const [givingTo, setGivingTo] = useState<string>();
  const [allAgents, setAllAgents] = useState<string[]>([]);
  // Which agent's toggle is mid-write, so a double-click can't fire the
  // read/attach-or-detach/write sequence twice while the first is in flight.
  const [givingBusy, setGivingBusy] = useState<string>();
  // Bumped after a write to a persona (give/take a skill) so the
  // agentDeps effect below re-reads the files it doesn't otherwise
  // watch — reload() alone only refreshes the config store, not this.
  const [agentNonce, setAgentNonce] = useState(0);
  // Set right after a fresh install with nothing declaring it yet — the
  // offer to give it to an agent. Cleared by picking one or by "not now";
  // either way it does not survive past this one install.
  const [justInstalled, setJustInstalled] = useState<{ name: string; source?: string }>();

  /**
   * One row per thing THIS ENVIRONMENT can see. The machine also holds
   * headless parts that only ever run in the TUI; showing them here
   * (which we did) buried the three cards that render in this app under
   * eight that never would — the desktop lists the desktop, the TUI
   * lists its own. A package still gets ONE row for all its parts
   * (fez-polls is gui+headless+skill, not three entries); it just needs
   * a part that lives here to earn the row.
   */
  const everything: {
    name: string;
    parts: string[];
    config?: SkillConfig;
    wanted: string[];
  }[] = useMemo(() => {
    const names = new Set([...Object.keys(localParts), ...Object.keys(installed)]);
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const parts = [...(localParts[name] ?? [])];
        if (installed[name]) parts.unshift("skill");
        return {
          name,
          parts,
          config: installed[name],
          // Through the resolver, not `includes(name)`: @scout declaring
          // `wallet=npm:@fezchat/wallet` on a machine that keyed the same
          // package "fez-wallet" DOES want this row. A raw key lookup
          // showed no ✓, so clicking "give to…" appended a second
          // declaration of a package the agent already had.
          wanted: agentDeps
            .filter((dep) =>
              dep.skills.some(
                (skill) => resolveInstalledSkill(installed, { name: skill, source: dep.sources[skill] })?.key === name
              )
            )
            .map((dep) => dep.agent),
        };
      })
      // EXTENSIONS = renders in this app (has a gui part). SKILLS = a
      // settings.json entry agents call, shown there only when the
      // package has no gui row to carry it. Headless-only packages
      // belong to the TUI's environment and get no desktop row at all.
      .filter((row) => {
        if (!only) return true;
        const inApp = row.parts.includes("gui");
        return only === "extensions" ? inApp : !inApp && !!row.config;
      });
  }, [localParts, installed, agentDeps, only]);

  /**
   * Declared by a persona, not present here — the only actionable gap.
   * `source` is what the persona said (or, for fez's own packages, what
   * owning the @fez scope lets us infer); `runs` is that spec resolved
   * to the literal command line, so the row can show it before you
   * commit rather than after. No source means no source: the row offers
   * a search, never a guess.
   */
  const missing: { agent: string; skill: string; source?: string; runs?: string }[] = useMemo(
    () =>
      agentDeps.flatMap((dep) =>
        dep.skills
          // The resolver, so this section agrees with the spawn path:
          // a declared name that resolves under a different local key is
          // NOT missing, and listing it here contradicted the agent's own
          // health badge.
          .filter((skill) => !resolveInstalledSkill(installed, { name: skill, source: dep.sources[skill] }))
          .map((skill) => {
            const source = dep.sources[skill] ?? wellKnownSource(skill);
            const config = source ? parseSkillSource(source) : undefined;
            return { agent: dep.agent, skill, source, runs: config && describeSkillSpec(config) };
          })
      ),
    [agentDeps, installed]
  );


  // A write elsewhere (remove_skill, write_skill) or an install → re-read the
  // store. Anything reading via useConfig() updates from the one signal.
  const reload = useCallback(() => bumpConfig(), []);

  useEffect(() => {
    reload();
    void (async () => {
      try {
        const names = await invoke<string[]>("list_personas");
        setAllAgents(names);
        const deps: { agent: string; skills: string[]; sources: Record<string, string> }[] = [];
        for (const agent of names) {
          const content = await invoke<string>("read_persona", { name: agent }).catch(() => "");
          // `web-search=npm:@brave/…` — the name the prompt sees, plus
          // where it comes from. declaredSkills is the SAME reader the
          // write path uses, and it is scoped to the frontmatter block:
          // a whole-file regex here (which this was) would disagree with
          // the writer on a persona whose BODY contains a look-alike
          // `mcpServers: [...]` line, so the ✓ and the write would
          // describe different files.
          const declared = declaredSkills(content);
          const skills = declared.map((d) => d.name);
          const sources = Object.fromEntries(
            declared.filter((d) => d.source).map((d) => [d.name, d.source as string])
          );
          if (skills.length > 0) deps.push({ agent, skills, sources });
        }
        setAgentDeps(deps);
      } catch { /* no personas dir */ }
    })();
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_SKILL_LISTING], limit: 100 }]);
      const latest = new Map<string, Listing>();
      for (const event of events as WireEvent[]) {
        try {
          const body = JSON.parse(event.content) as Omit<Listing, "authorPk" | "ts">;
          if (!body.name) continue;
          const key = `${event.pubkey}:${body.name}`;
          const prior = latest.get(key);
          if (prior && prior.ts >= event.created_at) continue;
          latest.set(key, { ...body, authorPk: event.pubkey, ts: event.created_at });
        } catch { /* malformed listing */ }
      }
      setListings([...latest.values()].sort((a, b) => b.ts - a.ts));
      // Install receipts (40201): distinct signer pubkeys per listing —
      // the decentralized download counter.
      const receipts = await wire.query([{ kinds: [KIND_SKILL_INSTALL], limit: 500 }]);
      const counts = new Map<string, Set<string>>();
      for (const receipt of receipts as WireEvent[]) {
        const skillName = receipt.tags.find((t) => t[0] === "skill")?.[1];
        const author = receipt.tags.find((t) => t[0] === "p")?.[1];
        if (!skillName || !author) continue;
        const key = `${author}:${skillName}`;
        if (!counts.has(key)) counts.set(key, new Set());
        counts.get(key)!.add(receipt.pubkey);
      }
      const merged = new Map([...counts.entries()].map(([key, pks]) => [key, pks.size]));
      // Cross-relay index overrides this relay's local view when reachable.
      try {
        if (!countsUrl()) throw new Error("no index configured");
        const res = await fetch(countsUrl(), { signal: AbortSignal.timeout(5000) });
        const body = (await res.json()) as { counts?: { skill_name: string; listing_author: string; installs: number }[] };
        for (const row of body.counts ?? []) merged.set(`${row.listing_author}:${row.skill_name}`, row.installs);
      } catch { /* index unreachable — relay-local counts stand */ }
      setInstalls(merged);
    })();
  }, [wire, reload, agentNonce]);

  /**
   * The name THIS agent uses for a catalog key, or undefined when it
   * doesn't declare it at all. `wanted` now counts an agent that reached
   * this skill under a different name, so taking it back has to remove
   * the name actually written in that persona — otherwise the ✓ appears
   * and the un-toggle silently does nothing.
   */
  const declaredNameFor = useCallback(
    (agent: string, key: string): string | undefined => {
      const dep = agentDeps.find((d) => d.agent === agent);
      return dep?.skills.find(
        (skill) => resolveInstalledSkill(installed, { name: skill, source: dep.sources[skill] })?.key === key
      );
    },
    [agentDeps, installed]
  );

  const runsLine = (skill: SkillConfig | Listing) =>
    skill.url ?? [skill.command, ...(skill.args ?? [])].join(" ");

  const publish = async (name: string, meta: { description: string; github?: string; npm?: string }) => {
    const config = installed[name];
    if (!config) return;
    // The button is already disabled for this, but a listing is signed
    // and travels — the check belongs where the event is built, not
    // only where it is clicked.
    const localPath = machineLocalPath(config);
    if (localPath) {
      setPublishing(undefined);
      return flash(`✗ can't list "${name}" — its command points at ${localPath}, which exists only on this machine`);
    }
    const envKeys = Object.keys(config.env ?? {});
    await wire.publish({
      kind: KIND_SKILL_LISTING,
      tags: [["d", name]],
      content: JSON.stringify({
        name,
        artifact: "mcp",
        description: meta.description,
        ...(config.url ? { type: "http", url: config.url } : { command: config.command, args: config.args ?? [] }),
        envKeys, // names only — values stay home
        installCmd: `fez skill install ${name}${envKeys.length ? " " + envKeys.map((key) => `--env ${key}=<value>`).join(" ") : ""}`,
        ...(meta.github ? { github: meta.github } : {}),
        ...(meta.npm ? { npm: meta.npm } : {}),
      }),
    });
    setPublishing(undefined);
    flash(`📡 published "${name}" — signed by you, env values not included`);
  };

  /** Marketplace persona → DRAFT for review in the agents pane. */
  const [personaState, setPersonaState] = useState<Record<string, string>>({});
  const installPersona = async (listing: Listing) => {
    if (!listing.persona) return;
    const stamped = listing.persona.replace(
      /^---\r?\n/,
      `---\nproposedBy: marketplace:${listing.authorPk.slice(0, 12)}\nproposedAt: ${new Date().toISOString()}\n`
    );
    const key = `${listing.authorPk}:${listing.name}`;
    try {
      await invoke("write_persona_draft", { name: listing.name, content: stamped });
      const receipt = await wire.signEvent({ kind: KIND_SKILL_INSTALL, tags: [["skill", `persona:${listing.name}`], ["p", listing.authorPk]], content: "" });
      await wire.publish({ kind: receipt.kind, tags: receipt.tags, content: receipt.content }).catch(() => {});
      if (countsUrl()) void fetch(countsUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(receipt), signal: AbortSignal.timeout(5000) }).catch(() => {});
      setPersonaState({ ...personaState, [key]: "done" });
      flash(`📝 "${listing.name}" is a draft — review the prompt in the agents pane (@ → proposed) and approve`);
    } catch (err) {
      setPersonaState({ ...personaState, [key]: String(err) });
    }
  };

  const copyCmd = (listing: Listing) => {
    const cmd = listing.installCmd ?? `fez skill install ${listing.name}`;
    void navigator.clipboard.writeText(cmd);
    setCopied(`${listing.authorPk}:${listing.name}`);
    setTimeout(() => setCopied(undefined), 2000);
  };

  const skillListings = (listings ?? []).filter((l) => (l.artifact ?? "mcp") === "mcp");

  const countKey = (listing: Listing) =>
    `${listing.authorPk}:${listing.artifact === "persona" ? "persona:" : ""}${listing.name}`;
  const ranked = [...(listings ?? [])]
    .filter((listing) => {
      if (filter === "all") return true;
      if (filter === "agents") return listing.artifact === "persona";
      if (filter === "skills") return (listing.artifact ?? "mcp") === "mcp";
      return listing.artifact !== "persona" && (listing.artifact ?? "mcp") !== "mcp";
    })
    .sort((a, b) => (installs.get(countKey(b)) ?? 0) - (installs.get(countKey(a)) ?? 0) || b.ts - a.ts);

  return (
    <main className="main">
      <header className="topbar">
        <div className="topbar-row">
          {only === "skills" ? "🔧 skills" : "⊞ extensions"}
          {<span className="ext-tabs">
            {(["browse", "installed"] as const).map((name) => (
              <button key={name} className={tab === name ? "ext-tab active" : "ext-tab"} onClick={() => setTab(name)}>
                {name}
                {name === "installed" && <span className="ext-tab-count">{everything.length}</span>}
              </button>
            ))}
          </span>}
        </div>
      </header>
      <div className="timeline pulse-scroll">
        {/* The vocabulary, once, at the top — as a KEY, not a sentence,
            because that is what it is. The tags on every row below are
            these three words, and until you know they name PLACES
            rather than sorts of thing, a row tagged "gui skill" reads
            as a contradiction instead of a package with two parts.

            It sits in the BODY, not the header: putting it in the
            topbar made the bar four rows tall and pushed its bottom
            rule off the top of the window, so this view alone looked
            like it had no header at all. */}
        <div className="ext-legend">
          {only === "skills" ? (
            <div className="ext-legend-lead">
              <strong>Skills</strong> are tools your agents call — an MCP server, granted to an agent in its persona. You configure them here; your agents use them.
            </div>
          ) : (
            <div className="ext-legend-lead">
              <strong>Extensions</strong> are features you install — a board, a repo panel, a slash command. Some also give your agents a skill, which appears under <strong>Skills</strong>.
            </div>
          )}
        </div>

        {/* ── the install just finished, nothing declares it yet ──
            Rendered OUTSIDE the tab switch, on purpose: the button that
            reaches this offer (relay listing "install…") lives on the
            "browse" tab, and "browse" is the default tab for Extensions.
            Gating this on tab === "installed" put the offer where the
            user installing from browse never sees it — a silent
            regression versus the app-wide flash() toast it replaced.
            Closes the loop the old toast punted on ("declare it in a
            persona yourself"): the exact typed-from-memory step this
            branch exists to delete. Does not force-switch tabs — that
            would yank the view out from under someone mid-browse. */}
        {justInstalled && (
          <div className="manage-notice">
            ✓ installed {justInstalled.name} — give it to?
            <div className="skill-give">
              {allAgents.map((agent) => {
                const busy = givingBusy === agent;
                return (
                  <button
                    key={agent}
                    className="ext-filter"
                    disabled={busy}
                    onClick={() => {
                      setGivingBusy(agent);
                      void setSkillOnAgent(agent, justInstalled.name, justInstalled.source, true)
                        .then((result) =>
                          reportSkillWrite(result, agent, justInstalled.name, true, () => {
                            reload();
                            setAgentNonce((n) => n + 1);
                          })
                        )
                        .finally(() => setGivingBusy(undefined));
                    }}
                  >
                    @{agent}
                  </button>
                );
              })}
              <button className="ext-filter" onClick={() => setJustInstalled(undefined)}>not now</button>
            </div>
          </div>
        )}

        {tab === "installed" && (
          <>
            {/* ── what your agents are missing ─────────────────────
                Only rendered when something is actually missing: a
                permanent "requirements" section that is always green
                trains you to stop reading it. */}
            {only !== "extensions" && missing.length > 0 && (
              <div className="skill-section ext-missing">
                <div className="manage-section">your agents need something</div>
                {missing.map(({ agent, skill, source, runs }) => {
                  const listing = skillListings.find((l) => l.name === skill);
                  return (
                    <div key={`${agent}:${skill}`} className="skill-row">
                      <div className="skill-main">
                        <span className="skill-name">
                          {skill}
                          <span className="role-tag missing-tag">not installed</span>
                        </span>
                        <span className="skill-desc">@{agent} declares it — until it exists, that agent runs without it</span>
                        {/* The command, before the button, not after it. */}
                        {runs && <code className="skill-cmd">{runs}</code>}
                        {source && !runs && (
                          <span className="skill-env">@{agent} declares <code>{source}</code>, which fez can't resolve</span>
                        )}
                        {!source && !listing && (
                          <span className="skill-env">
                            no source declared — "{skill}" is a name, and several unrelated packages answer to names like it
                          </span>
                        )}
                      </div>
                      <div className="skill-actions">
                        {runs && source ? (
                          <button
                            className="agent-action"
                            onClick={() =>
                              setInstalling({
                                name: skill,
                                ...parseSkillSource(source)!,
                                provenance: `@${agent} declares this source in its persona file`,
                                source,
                              })
                            }
                          >
                            install…
                          </button>
                        ) : listing ? (
                          <button className="agent-action" onClick={() => setInstalling(fromListing(listing))}>install…</button>
                        ) : (
                          <button className="agent-action" onClick={() => setFinding({ agent, skill })}>find it…</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── extensions that need setting up ────────────────
                Rendered above the inventory because a card here is
                almost always an ACTION — connect an account, choose
                what to watch — while the list below is a fact. An
                extension with nothing to configure adds nothing. */}
            {/* Extension settings panels render in SettingsPane's
                "extensions" tab — this view finds, installs and removes;
                configuring lives with the other settings. (Source-scoped
                panels still configure from their channel rail group.) */}

            {/* ── everything on this machine ───────────────────── */}
            <div className="skill-section">
              <div className="manage-section">{only === "extensions" ? "installed" : "defined here"}</div>
              {everything.length === 0 && <div className="pane-empty">nothing installed yet — see browse</div>}
              {everything.map(({ name, parts, config, wanted }) => {
                const localPath = machineLocalPath(config);
                return (
                <div key={name} className="skill-row">
                  <div className="skill-main">
                    <span className="skill-name">
                      {name}
                      {/* Chips earn their place by DIFFERENTIATING. In
                          the skills list every row is a skill, so a
                          "skill" chip on all ten restated the heading
                          ten times; the other parts (gui, headless) are
                          still worth naming. */}
                      {parts.filter((part) => !(only === "skills" && part === "skill")).map((part) => (
                        <span
                          key={part}
                          className="role-tag"
                          title={PART_WHERE[part] ? `${PART_WHERE[part].what} — ${PART_WHERE[part].where}` : part}
                        >
                          {part}
                        </span>
                      ))}
                      {localPath && (
                        <span
                          className="role-tag local-tag"
                          title="Its command names a path on this machine, so it exists nowhere else. Publish it to npm and the command becomes portable."
                        >
                          this machine only
                        </span>
                      )}
                    </span>
                    {wanted.length > 0 && (
                      <span className="skill-desc">used by {wanted.map((a) => `@${a}`).join(", ")}</span>
                    )}
                    {config && <code className="skill-cmd">{runsLine(config)}</code>}
                    {/* Every part it has, not only the one with a
                        command — a row showing just the mcp line looked
                        like a bare MCP server when it is three parts. */}
                    {parts.filter((part) => part !== "skill" && PART_WHERE[part]).map((part) => (
                      <code key={part} className="skill-cmd">{PART_WHERE[part].what}</code>
                    ))}
                    {config?.env && Object.keys(config.env).length > 0 && (
                      <span className="skill-env skill-deps">
                        env:{" "}
                        {Object.keys(config.env).map((key) => (
                          <EnvKeyStatus key={key} skill={name} envKey={key} plaintext={!!config.env?.[key]?.trim()} editable={false} />
                        ))}
                      </span>
                    )}
                  </div>
                  {config && (
                    <div className="skill-actions">
                      {publishing === name ? (
                        <PublishForm onPublish={(meta) => void publish(name, meta)} onCancel={() => setPublishing(undefined)} />
                      ) : (
                        <>
                          {/* "share" read as Slack-share — share it WHERE,
                              with whom? It publishes a signed listing to
                              this workspace's relay, and the browse tab
                              calls those "listed on your relay". Same
                              word both ends, so the round trip is
                              legible: you list it, it shows up listed. */}
                          <button
                            className="mini"
                            disabled={!!localPath}
                            title={
                              localPath
                                ? `Can't list this: its command points at ${localPath}, which exists only on this machine. Anyone installing it would get that path verbatim and their agents would spawn against a directory that isn't there. Publish the package first.`
                                : `publish a signed listing to this workspace's relay — everyone here sees "${name}", the command it runs, and the names of any keys it needs. Values stay on this machine.`
                            }
                            onClick={() => setPublishing(name)}
                          >
                            ↗ list on relay
                          </button>
                          <button className="mini" onClick={() => setGivingTo(givingTo === name ? undefined : name)}>
                            give to…
                          </button>
                          <button className="mini" title="remove from this machine" onClick={() => void invoke("remove_skill", { name }).then(reload)}>✕</button>
                        </>
                      )}
                    </div>
                  )}
                  {givingTo === name && (
                    <div className="skill-give">
                      {allAgents.map((agent) => {
                        const has = wanted.includes(agent);
                        const busy = givingBusy === agent;
                        return (
                          <button
                            key={agent}
                            className={has ? "ext-filter active" : "ext-filter"}
                            disabled={busy}
                            onClick={() => {
                              const on = !has;
                              setGivingBusy(agent);
                              // Giving uses this machine's key; taking back
                              // uses whatever name that agent wrote.
                              const target = on ? name : declaredNameFor(agent, name) ?? name;
                              void setSkillOnAgent(agent, target, config?.source, on)
                                .then((result) =>
                                  reportSkillWrite(result, agent, name, on, () => {
                                    reload();
                                    setAgentNonce((n) => n + 1);
                                  })
                                )
                                .finally(() => setGivingBusy(undefined));
                            }}
                          >
                            @{agent} {has ? "✓" : ""}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </>
        )}

        {tab === "browse" && only === "extensions" && (
          <ExtensionGallery
            client={client}
            installed={new Set(everything.map((row) => row.name))}
            onInstalled={reload}
            onNotice={flash}
          />
        )}
        {tab === "browse" && only !== "extensions" && (
          <div className="skill-section">
            <div className="manage-section">
              <span>listed on your relay</span>
              <span className="ext-filters">
                {(["all", "agents", "skills", "packs"] as const).map((name) => (
                  <button key={name} className={filter === name ? "ext-filter active" : "ext-filter"} onClick={() => setFilter(name)}>
                    {name}
                  </button>
                ))}
              </span>
            </div>
            <div className="settings-hint">
              Signed listings, ranked by installs. Installing an agent lands as a DRAFT you review; installing a
              skill adds its definition (secrets stay yours, in the keychain). Read before installing.
            </div>
            {!listings && <div className="pane-empty">loading…</div>}
            {listings && ranked.length === 0 && (
              <div className="pane-empty">
                nothing listed on this relay yet — share something of yours from the installed tab
              </div>
            )}
            {ranked.map((listing) => {
            const key = `${listing.authorPk}:${listing.name}`;
            const count = installs.get(countKey(listing)) ?? 0;
            const isPersona = listing.artifact === "persona";
            const isMcp = (listing.artifact ?? "mcp") === "mcp";
            const state = personaState[key];
            const isInstalled = isMcp && !!installed[listing.name];
            return (
              <div key={key} className="skill-row market">
                <div className="skill-main">
                  <span className="skill-name">
                    {isPersona ? `@${listing.name}` : listing.name}
                    <span className="role-tag">{isPersona ? "agent" : isMcp ? "skill" : listing.artifact}</span>
                    {isInstalled && <span className="role-tag installed-tag">installed</span>}
                    <span className="skill-installs">⇩ {count}</span>
                  </span>
                  {listing.description && <span className="skill-desc">{listing.description}</span>}
                  {isPersona && listing.requiredSkills && listing.requiredSkills.length > 0 && (
                    <span className="skill-env skill-deps">
                      needs:{" "}
                      {listing.requiredSkills.map((skill) => (
                        <span key={skill} className="skill-dep">{skill}{installed[skill] ? " ✓" : ""}</span>
                      ))}
                    </span>
                  )}
                  {isMcp && runsLine(listing) && <code className="skill-cmd">{runsLine(listing)}</code>}
                  {isMcp && listing.envKeys && listing.envKeys.length > 0 && (
                    <span className="skill-env">needs env: {listing.envKeys.join(", ")}</span>
                  )}
                  {isPersona && listing.persona && (
                    <details className="persona-peek">
                      <summary>view the persona (read before installing)</summary>
                      <pre className="draft-content">{listing.persona}</pre>
                    </details>
                  )}
                  {!isPersona && !isMcp && (
                    <code className="skill-install-cmd" title="click to copy" onClick={() => copyCmd(listing)}>
                      {copied === key ? "✓ copied" : `$ ${listing.installCmd ?? ""}`}
                    </code>
                  )}
                  <span className="skill-author">
                    <Avatar pk={listing.authorPk} size={14} /> {client.displayName(listing.authorPk)}
                    {listing.github && <button className="skill-link" onClick={() => void openUrl(listing.github!)}>github</button>}
                    {listing.npm && <button className="skill-link" onClick={() => void openUrl(`https://www.npmjs.com/package/${listing.npm}`)}>npm</button>}
                  </span>
                  {state && state !== "done" && <span className="ob-error">{state}</span>}
                </div>
                <div className="skill-actions">
                  {isPersona &&
                    (state === "done" ? (
                      <span className="role-tag installed-tag">drafted — review in agents</span>
                    ) : (
                      <button className="agent-action" onClick={() => void installPersona(listing)}>install as draft…</button>
                    ))}
                  {isMcp && !isInstalled && <button className="agent-action" onClick={() => setInstalling(fromListing(listing))}>install…</button>}
                </div>
              </div>
            );
          })}
          </div>
        )}

        {finding && (
          <FindSource
            skill={finding.skill}
            agent={finding.agent}
            onCancel={() => setFinding(undefined)}
            onPick={(source, provenance) => {
              setFinding(undefined);
              setInstalling({
                name: finding.skill,
                ...parseSkillSource(source)!,
                provenance,
                source,
                // You just answered "which package?" — writing it back
                // means neither you nor the next machine has to answer
                // it again, and the persona becomes portable.
                rememberIn: finding.agent,
              });
            }}
          />
        )}

        {installing && (
          <InstallDialog
            target={installing}
            wire={wire}
            onDone={(didInstall) => {
              const done = installing;
              setInstalling(undefined);
              if (!didInstall) return;
              reload();
              if (done.rememberIn && done.source) {
                void rememberSource(done.rememberIn, done.name, done.source)
                  .then((ok) =>
                    flash(
                      ok
                        ? `✓ "${done.name}" installed, and @${done.rememberIn} now records where it came from — hand that persona to anyone and their fez knows what to fetch`
                        : `✓ "${done.name}" installed — couldn't update @${done.rememberIn}'s file, so add =${done.source} there by hand to make it portable`
                    )
                  );
              } else {
                setJustInstalled({ name: done.name, source: done.source });
              }
            }}
          />
        )}
      </div>
    </main>
  );
}

function PublishForm({
  onPublish,
  onCancel,
}: {
  onPublish: (meta: { description: string; github?: string; npm?: string }) => void;
  onCancel: () => void;
}) {
  const [description, setDescription] = useState("");
  const [github, setGithub] = useState("");
  const [npm, setNpm] = useState("");
  const submit = () => {
    if (!description.trim()) return;
    onPublish({ description: description.trim(), github: github.trim() || undefined, npm: npm.trim() || undefined });
  };
  return (
    <span className="publish-form stacked">
      {/* Publishing is a signature, so the form says whose and over
          what. The listing carries the COMMAND — that is the thing
          other people will run — and the env KEY NAMES, never values. */}
      <span className="publish-what">
        Signed by you, to this workspace's relay. Everyone here will see the command it runs and can install it in
        one click. Your env values stay on this machine — only the key names travel.
      </span>
      <input className="manage-input" value={description} autoFocus placeholder="what does it do?" onChange={(e) => setDescription(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
      <input className="manage-input" value={github} spellCheck={false} placeholder="github url (optional)" onChange={(e) => setGithub(e.target.value)} />
      <input className="manage-input" value={npm} spellCheck={false} placeholder="npm package (optional)" onChange={(e) => setNpm(e.target.value)} />
      <span className="agent-actions">
        <button className="mini" disabled={!description.trim()} onClick={submit}>publish</button>
        <button className="mini" onClick={onCancel}>cancel</button>
      </span>
    </span>
  );
}

/**
 * Write a source back into the persona that declared the bare name, so
 * `mcpServers: [web-search]` becomes `[web-search=npm:@brave/…]`. Only
 * ever touches the one entry it was told about, and leaves the file
 * alone entirely if the line isn't there to edit.
 */
async function rememberSource(agent: string, skill: string, source: string): Promise<boolean> {
  try {
    const content = await invoke<string>("read_persona", { name: agent });
    const next = rememberSkillSource(content, skill, source);
    if (!next) return false;
    await invoke("update_persona", { name: agent, content: next });
    return true;
  } catch {
    return false;
  }
}

/**
 * "changed" | "already" | "unsafe" | "error" — attachSkill/detachSkill
 * collapse "no change needed" and "not safe to edit" into one `undefined`
 * (by design: callers just skip the write either way), but a caller that
 * reports outcomes to a human needs to tell those apart, plus the genuine
 * failure case. So this checks current state itself before delegating,
 * rather than trying to reverse-engineer which `undefined` it got back.
 */
type SkillWriteResult = "changed" | "already" | "unsafe" | "error";

/**
 * Give a skill to an agent, or take it back. The write is the same one
 * the persona editor performs — one line, everything else verbatim.
 */
async function setSkillOnAgent(agent: string, skill: string, source: string | undefined, on: boolean): Promise<SkillWriteResult> {
  try {
    const content = await invoke<string>("read_persona", { name: agent });
    const has = declaredSkills(content).some((d) => d.name === skill);
    if (has === on) return "already"; // the on-disk file already matches — the UI's view was stale
    const next = on ? attachSkill(content, skill, source) : detachSkill(content, skill);
    if (!next) return "unsafe"; // no frontmatter block to edit
    await invoke("update_persona", { name: agent, content: next });
    return "changed";
  } catch {
    return "error";
  }
}

/**
 * Turn a `setSkillOnAgent` outcome into the flash + refresh the human
 * sees — the one switch both call sites (the post-install offer and the
 * "give to…" toggle) share. "changed" and "already" are BOTH
 * non-failures and both refresh: an "already" means the UI's view was
 * stale (hand-edited file, another window), not a repeat success or a
 * failure, so refreshing corrects what's shown rather than reporting
 * anything went wrong. "unsafe" names the actual reason nothing was
 * written (no frontmatter block); "error" is the only genuine failure.
 * Collapsing these four into fewer cost two review rounds on Task 6.
 */
function reportSkillWrite(result: SkillWriteResult, agent: string, skill: string, on: boolean, refresh: () => void) {
  if (result === "changed") {
    flash(on ? `@${agent} gets "${skill}" on next spawn` : `@${agent} no longer has "${skill}" — takes effect on next spawn`);
    refresh();
  } else if (result === "already") {
    flash(on ? `@${agent} already has "${skill}"` : `@${agent} already doesn't have "${skill}"`);
    refresh();
  } else if (result === "unsafe") {
    flash(`✗ @${agent}'s persona has no frontmatter block, so fez can't edit it automatically`);
  } else {
    flash(
      on
        ? `✗ couldn't give "${skill}" to @${agent} — check its persona file`
        : `✗ couldn't remove "${skill}" from @${agent} — check its persona file`
    );
  }
}

/** The consent gate: full command verbatim + env values filled locally. */
function InstallDialog({ target, wire, onDone }: { target: InstallTarget; wire: BrowserWire; onDone: (didInstall: boolean) => void }) {
  const [env, setEnv] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  const install = async () => {
    const missing = (target.envKeys ?? []).filter((key) => !env[key]?.trim());
    if (missing.length > 0) return setError(`fill in: ${missing.join(", ")}`);
    // Provenance, when there is any — the whole point of the branch.
    // `write_skill` REPLACES the entry, so an omitted `source` here does
    // not merely miss a field: it drops whatever the CLI recorded when
    // the same skill was installed from a terminal. Both fields are
    // omitted rather than written empty, matching skillEntryFor.
    const pkg = packageFromSource(target.source);
    const config: SkillConfig = {
      ...(target.url
        ? { type: "http", url: target.url }
        : {
            command: target.command,
            ...(target.args?.length ? { args: target.args } : {}),
            ...(target.envKeys?.length ? { env } : {}),
          }),
      ...(target.source ? { source: target.source } : {}),
      ...(pkg ? { package: pkg } : {}),
      ...(target.description ? { description: target.description } : {}),
    };
    try {
      await invoke("write_skill", { name: target.name, configJson: JSON.stringify(config) });
      // The receipt: +1 on the listing's install count, signed by you —
      // on the relay (truth) and pushed to the cross-relay index
      // (number). Only for relay listings: a receipt names an author,
      // and there is nobody to credit for a package you found yourself.
      if (target.authorPk) {
        const receipt = await wire.signEvent({ kind: KIND_SKILL_INSTALL, tags: [["skill", target.name], ["p", target.authorPk]], content: "" });
        await wire.publish({ kind: receipt.kind, tags: receipt.tags, content: receipt.content, created_at: receipt.created_at }).catch(() => {});
        if (countsUrl()) void fetch(countsUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(receipt),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
      onDone(true);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="overlay" onMouseDown={() => onDone(false)}>
      <div className="search-box install-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="install-head">install "{target.name}"</div>
        <div className="settings-hint">{target.provenance}</div>
        <div className="settings-hint">
          This exact command will run on your machine whenever an agent with this skill spawns:
        </div>
        <pre className="draft-content">{target.url ?? [target.command, ...(target.args ?? [])].join(" ")}</pre>
        {(target.envKeys ?? []).map((key) => (
          <div key={key} className="settings-field">
            <label>{key} (stored locally, never published)</label>
            <input
              className="manage-input"
              type="password"
              value={env[key] ?? ""}
              onChange={(e) => setEnv({ ...env, [key]: e.target.value })}
            />
          </div>
        ))}
        {error && <div className="ob-error">{error}</div>}
        <div className="agent-actions">
          <button className="agent-action" onClick={() => void install()}>I read the command — install</button>
          <button className="agent-action" onClick={() => onDone(false)}>cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * One extension's settings card, fenced.
 *
 * Third-party render code on a page the user needs in order to REMOVE
 * that extension: without a boundary, a card that throws takes the
 * extensions page with it and the only way out is a config file.
 */
export class ExtensionPanel extends Component<
  { panel: { name: string; render: () => React.ReactNode | Dispose | void } },
  { failed?: string }
> {
  state: { failed?: string } = {};
  static getDerivedStateFromError(err: unknown): { failed: string } {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
  render(): React.ReactNode {
    if (this.state.failed) {
      return <div className="ext-panel-broken">this extension's settings failed to render — {this.state.failed}</div>;
    }
    try {
      // The mount form (a returned disposer) has no host node to mount
      // into here — this boundary predates it and today's registered
      // extensions only ever return an element. MountPoint (the real
      // host-node bridge, dispatching on classifyMountResult) is Task 5.
      const result = this.props.panel.render();
      return <>{result as React.ReactNode}</>;
    } catch (err) {
      return <div className="ext-panel-broken">this extension's settings failed to render — {String(err)}</div>;
    }
  }
}
