import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { readiness, prepareStarterTeam } from "./welcome";
import { useConfig, reloadConfig } from "./config-store";
import { InstallOffer } from "./InstallOffer";
import { setSkillOnAgent } from "./SkillsView";
import { researchPrompt, researchTitle, researchTool } from "./starter-research";
import { relaySet } from "./relay";

async function inspectTeam() {
  const [ready, names] = await Promise.all([readiness(), invoke<string[]>("list_personas")]);
  const [drift, quill] = await Promise.all(["drift", "quill"].map((name) =>
    names.includes(name) ? invoke<string>("read_persona", { name }) : Promise.resolve(undefined)
  ));
  return { ready: ready.authed && ready.runner, drift, quill };
}

/** A first task for the existing welcome team; Web owns the research tools. */
export default function ResearchStarter({ client, channelId, onStarted, onOpenAgents }: {
  client: FezClient;
  channelId: string;
  onStarted: (rootId: string) => void;
  onOpenAgents: () => void;
}) {
  const config = useConfig();
  const storageKey = `fez-research-topic-${client.pubkey}-${channelId}`;
  const restartKey = `fez-research-restart-${client.pubkey}`;
  const [topic, setTopic] = useState(() => localStorage.getItem(storageKey) ?? "");
  const [team, setTeam] = useState<Awaited<ReturnType<typeof inspectTeam>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsRestart, setNeedsRestart] = useState(() => !!localStorage.getItem(restartKey));
  const sending = useRef(false);
  const pendingRoot = useRef<string | undefined>(undefined);
  const web = researchTool(team?.drift ?? "", config.skills);

  useEffect(() => {
    let active = true;
    const refresh = () => void inspectTeam().then((next) => {
      if (active) setTeam(next);
    }).catch((err) => { if (active) setError(String(err)); });
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [config.skills]);

  const checkAgain = async () => {
    setBusy(true); setError("");
    try { setTeam(await inspectTeam()); await reloadConfig(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const prepare = async () => {
    setBusy(true); setError("");
    try { await prepareStarterTeam(client, channelId); setTeam(await inspectTeam()); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const giveWeb = async () => {
    if (!web || sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      type Spawn = { persona?: string; bin?: string; channels?: string[]; repo?: string; line?: string };
      const rows = await invoke<Spawn[]>("spawned_agents");
      const pending = localStorage.getItem(restartKey);
      const previous: Spawn = pending ? JSON.parse(pending)
        : rows.find((row) => row.persona === "drift" && (!row.bin || row.bin === "fez-agent")) ?? {};
      const result = await setSkillOnAgent("drift", web.key, "npm:@fezchat/web", true);
      if (result === "unsafe" || result === "error") throw new Error("Couldn't give Web to Drift. Open Agents to check its configuration.");
      localStorage.setItem(restartKey, JSON.stringify(previous)); setNeedsRestart(true);
      // Explicit on the button's setup note: the running harness must
      // reload its tool list, just as it does after a persona-editor save.
      if (await invoke<boolean>("agent_alive", { persona: "drift", bin: "fez-agent" })) {
        if (!await invoke<boolean>("kill_agent", { persona: "drift", bin: "fez-agent" })) {
          throw new Error("Web is saved, but Drift couldn't be stopped. Open Agents to restart it before trying again.");
        }
      }
      const pid = await invoke<number>("spawn_agent", {
        persona: "drift", channels: [...new Set([...(previous?.channels ?? []), channelId])],
        owner: client.pubkey, relays: relaySet().join(","), repo: previous?.repo ?? null, baseBranch: previous?.line ?? null,
      });
      if (!pid) throw new Error("Web is saved, but the background runner must restart Drift. Open Agents to check its status before trying again.");
      localStorage.removeItem(restartKey); setNeedsRestart(false);
      setTeam(await inspectTeam());
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { sending.current = false; setBusy(false); }
  };

  const start = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const prompt = researchPrompt(topic);
      const next = await inspectTeam();
      setTeam(next);
      // Re-read at the action boundary: setup may have changed in another window.
      await reloadConfig();
      const skills = JSON.parse(await invoke<string>("read_skills"));
      if (needsRestart || !next.ready || !next.drift || !next.quill || !researchTool(next.drift, skills)?.attached) {
        throw new Error("Finish the setup below, then start your brief.");
      }
      // Resolve LOCAL identities through the public-key-only bridge. This
      // also covers a first click that beats the welcome introductions.
      const keys: string[] = [];
      for (const name of ["drift", "quill"]) {
        const pk = await invoke<string>("get_pubkey", { account: `agent:${name}` });
        if (!client.state.isMember(pk)) await client.invite(pk, "bot");
        await client.attestAgent(pk);
        keys.push(pk);
      }
      // A plain root, then a directed reply: every draft, tool activity,
      // handoff and answer receives the same thread root from the start.
      if (!pendingRoot.current) {
        pendingRoot.current = (await client.sendChannelMessage(researchTitle(topic), { channelId })).id;
      }
      await client.sendChannelMessage(prompt, { channelId, threadRootId: pendingRoot.current, mentionPks: [keys[0]] });
      localStorage.removeItem(storageKey);
      onStarted(pendingRoot.current);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { sending.current = false; setBusy(false); }
  };

  const ready = team?.ready && team.drift && team.quill && web?.attached && !needsRestart;
  return <section className="research-starter" aria-label="Try your team">
    <h3>Try your team</h3>
    <p>Drift researches. Quill turns the findings into a brief with sources. Follow both in one thread.</p>
    <form onSubmit={(event) => { event.preventDefault(); void start(); }}>
      <label htmlFor="research-topic">What would you like to understand?</label>
      <input id="research-topic" className="manage-input" value={topic} maxLength={500} required
        placeholder="e.g. Local vs cloud AI: privacy, cost, and speed"
        disabled={busy || !!pendingRoot.current}
        onChange={(event) => { setTopic(event.target.value); localStorage.setItem(storageKey, event.target.value); }} />
      <button className="mini primary" type="submit" disabled={!ready || busy || !topic.trim()}>
        {busy ? "Please wait…" : pendingRoot.current ? "Retry in this thread" : "Start my brief"}
      </button>
    </form>
    {!team || !config.loaded ? <p role="status">Checking your team…</p> : !team.ready ? (
      <p>Connect a model first. <button className="fr-link" onClick={onOpenAgents}>Open Agents</button></p>
    ) : !team.drift || !team.quill ? (
      <p>Create your starter teammates using your connected model. <button className="fr-link" disabled={busy} onClick={() => void prepare()}>Set up starter team</button></p>
    ) : !web ? (
      <InstallOffer content="fez:install @fezchat/web" authorName="This demo" client={client} />
    ) : !web.attached || needsRestart ? (
      <div className="research-setup">
        <p>Give Drift permission to search and read public websites. This restarts Drift to load its new tools.</p>
        <button className="mini" disabled={busy} onClick={() => void giveWeb()}>{needsRestart ? "Restart Drift" : "Give Web to Drift"}</button>
      </div>
    ) : <p className="research-ready">Ready · uses your connected model and its normal usage charges.</p>}
    {error && <p role="alert" className="ob-error">{error}</p>}
    {!ready && <button className="fr-link" disabled={busy} onClick={() => void checkAgain()}>Check setup again</button>}
  </section>;
}
