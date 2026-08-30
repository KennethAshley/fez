/**
 * fez-ridges, gui part — the bounty-rail pane.
 *
 * Entry is `src/view.tsx` (not `gui.tsx`) because `fez pack` — the
 * build that hashes this file's CSS-module import and emits the
 * companion `dist/gui.css` beside `dist/gui.js` — has a hardcoded entry
 * path (src/cli/pack.ts). The manifest's `fez.parts.gui` still says
 * `dist/gui.js`; only this source file's name changed, nothing
 * user-facing (see the T5 report for the alternatives considered).
 *
 * Own React (mount model): the host hands `mount(host)` a DOM node,
 * we `createRoot(host).render(...)`, and return a disposer.
 *
 * Visual authority: docs/superpowers/specs/2026-08-30-ridges-mock.html —
 * classes, copy, and status vocabulary are ported verbatim except where
 * a data reality forced a change (documented inline below and in the
 * task report).
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Avatar } from "@fezchat/ui";
import styles from "./gui.module.css";
import { paneFacts, statusParts, relTime, issueLabel } from "./gui-logic.js";
import type { RidgesJob } from "./store.js";

/** The narrow slice of the real GuiExtensionApi this pane actually
 * touches — `client` kept optional because the host withholds it
 * entirely without `read:channels`, whatever the exported type claims
 * (see gui-extensions.ts's `may("read:channels") ? client : undefined`). */
export interface GuiApi {
  registerNavView(name: string, opts: { glyph: string; label: string }, render: (host?: HTMLElement) => () => void): void;
  storage: { get<T = unknown>(key: string): Promise<T | undefined> };
  openUrl(url: string): Promise<void>;
  client?: {
    pkByName?(name: string): string | undefined;
    sendChannelMessage?(text: string, opts?: { channelId?: string }): Promise<unknown>;
  };
}

const LIVE_STATUSES = new Set<RidgesJob["status"]>(["working", "pr-open"]);

function byNewest(a: RidgesJob, b: RidgesJob): number {
  return new Date(b.ts).getTime() - new Date(a.ts).getTime();
}

/** The dispatching agent's face — the real Avatar (named cast sprite or
 * a generated one) when the roster resolves a pk, else a plain initial
 * block. No hand-drawn per-name fallback here: that's Avatar's job. */
function Face({ persona, pk }: { persona: string; pk?: string }) {
  if (pk) return <Avatar pk={pk} name={persona} size={22} />;
  return <span className={styles.face}>{persona.trim() ? persona[0]!.toUpperCase() : ""}</span>;
}

/** The status line, two-tone: merged/closed get a colored ✓/✕ mark
 * (mock's `.st-merged b`/`.st-closed b`) followed by the dim rest;
 * everything else is just the dim rest. */
function StatusLine({ job, now }: { job: RidgesJob; now: Date }) {
  const { mark, rest } = statusParts(job, now);
  if (!mark) return <>{rest}</>;
  const markClass = job.status === "merged" ? styles.stMergedMark : styles.stClosedMark;
  return (
    <>
      <b className={markClass}>{mark}</b>
      {rest}
    </>
  );
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function Row({ job, api, now }: { job: RidgesJob; api: GuiApi; now: Date }) {
  const live = LIVE_STATUSES.has(job.status);
  const pk = api.client?.pkByName?.(job.persona);
  const label = issueLabel(job);
  const openIssue = () => {
    if (isHttpUrl(job.issueUrl)) void api.openUrl(job.issueUrl);
  };
  // M4: prUrl is GitHub's own html_url via the poller, but it's still
  // externally-sourced data landing in an onClick — same guard issueUrl
  // gets, not a trust distinction.
  const openPr = () => {
    if (job.prUrl && isHttpUrl(job.prUrl)) void api.openUrl(job.prUrl);
  };

  if (job.status === "refused") {
    // Refused rows never got as far as owner/repo/issueNumber — render
    // them from the issue URL and the status alone, per the ledger note.
    return (
      <div className={`${styles.job} ${styles.refused}`}>
        <div />
        <div className={styles.railline}>
          <span className={styles.agent}>{job.persona}</span>
          <span className={styles.node}>
            {isHttpUrl(job.issueUrl) ? (
              <a onClick={openIssue}>{label}</a>
            ) : (
              <span>{label}</span>
            )}
          </span>
        </div>
        <div className={`${styles.status} ${styles.stRefused}`}>
          <StatusLine job={job} now={now} />
        </div>
      </div>
    );
  }

  const statusClass =
    job.status === "working"
      ? styles.stWork
      : job.status === "pr-open"
        ? styles.stOpen
        : job.status === "merged"
          ? styles.stMerged
          : job.status === "closed"
            ? styles.stClosed
            : styles.stWarn;

  return (
    <div className={`${styles.job} ${live ? styles.live : ""}`}>
      <Face persona={job.persona} pk={pk} />
      <div className={styles.railline}>
        <span className={styles.agent}>{job.persona}</span>
        <span className={styles.node}>
          <a onClick={openIssue}>{label}</a>
        </span>
        <span className={styles.rail}>
          <span className={styles.track} />
          {typeof job.usd === "number" && <span className={styles.price}>${job.usd.toFixed(2)}</span>}
          {job.status === "working" && <span className={styles.spark} />}
          <span className={styles.tip}>▶</span>
        </span>
        {job.prUrl ? (
          <span className={styles.pr}>
            <a onClick={openPr}>PR#{job.prNumber}</a>
          </span>
        ) : (
          <span className={styles.ghost}>PR …</span>
        )}
      </div>
      <div className={`${styles.status} ${statusClass}`}>
        <StatusLine job={job} now={now} />
      </div>
      {job.title && <div className={styles.title}>{job.title}</div>}
      <div className={styles.meta}>
        {(job.status === "working" || job.status === "pr-open" || job.status === "payment-unclear") && (
          <span>{relTime(job.updatedAt, now)}</span>
        )}
        <span className={styles.receipt} title="the wallet's x402 receipt">
          receipt ⛁
        </span>
        {job.status === "pr-open" && job.prUrl && <a onClick={openPr}>view diff</a>}
      </div>
    </div>
  );
}

function RidgesPane({ api }: { api: GuiApi }) {
  const [jobs, setJobs] = useState<RidgesJob[]>([]);
  const [network, setNetwork] = useState<string | undefined>(undefined);
  const [showDispatch, setShowDispatch] = useState(false);
  const [url, setUrl] = useState("");
  const now = new Date();

  useEffect(() => {
    void api.storage.get<RidgesJob[]>("jobs").then((j) => setJobs(j ?? []));
    void api.storage.get<string>("network").then(setNetwork);
  }, [api]);

  const send = async () => {
    const u = url.trim();
    if (!u || !api.client?.sendChannelMessage) return;
    await api.client.sendChannelMessage(`/ridges ${u}`);
    setUrl("");
    setShowDispatch(false);
  };

  const live = jobs.filter((j) => LIVE_STATUSES.has(j.status)).sort(byNewest);
  const done = jobs.filter((j) => !LIVE_STATUSES.has(j.status)).sort(byNewest);
  const facts = paneFacts(jobs, now);
  const factsLine = `${facts.live} live · ${facts.merged} merged · $${facts.weekUsd.toFixed(2)} this week`;

  return (
    <div className={styles.pane}>
      <h1 className={styles.h1}>ridges</h1>
      <p className={styles.pageSub}>Pay a coding subnet to turn a GitHub issue into a pull request. One payment, one PR.</p>
      <div className={styles.pageRule}>
        <button className={styles.pageFactAction} onClick={() => setShowDispatch((v) => !v)}>
          + dispatch an issue
        </button>
        {jobs.length > 0 && <span className={styles.pageFact}>{factsLine}</span>}
        <span className={styles.spacer} />
        {network && <span className={styles.pageFact}>{network}</span>}
      </div>

      {showDispatch && api.client?.sendChannelMessage && (
        <div className={styles.dispatch}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/you/repo/issues/212 — needs the Ridgeline app installed on the repo"
          />
          <button onClick={() => void send()}>pay &amp; dispatch</button>
        </div>
      )}
      <p className={styles.hint}>
        {api.client?.sendChannelMessage ? "or from any channel: " : "dispatch from any channel: "}
        <b>/ridges &lt;issue-url&gt;</b> — big spends still ask you first ✅
      </p>

      {jobs.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.railline}>
            <span className={styles.agent}>&nbsp;</span>
            <span className={styles.ghost}>issue</span>
            <span className={styles.rail}>
              <span className={styles.track} />
              <span className={styles.price}>$0.75</span>
              <span className={styles.tip}>▶</span>
            </span>
            <span className={styles.ghost}>PR</span>
          </div>
          <p className={styles.emptyLine}>Your first job goes here.</p>
          <p className={styles.emptyHow}>
            Hand any agent a GitHub issue — <code>/ridges &lt;issue-url&gt;</code> — and the subnet's best coding
            agent opens the PR on your repo. Install the Ridgeline app on the repo first; payments ride your
            wallet's caps and ✅ consent.
          </p>
        </div>
      ) : (
        <>
          {live.length > 0 && (
            <>
              <div className={styles.section}>live</div>
              {live.map((j) => (
                <Row key={j.id} job={j} api={api} now={now} />
              ))}
            </>
          )}
          {done.length > 0 && (
            <>
              <div className={styles.section}>done</div>
              {done.map((j) => (
                <Row key={j.id} job={j} api={api} now={now} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

export function activate(api: GuiApi): void {
  api.registerNavView("ridges", { glyph: "⛏", label: "ridges" }, (host) => {
    const root = createRoot(host!);
    root.render(<RidgesPane api={api} />);
    return () => root.unmount();
  });
}
