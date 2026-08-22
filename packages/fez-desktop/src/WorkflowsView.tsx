import type { FezClient } from "@fezchat/client";

/**
 * Workflow runs — the GUI over fez-workflows' 47200 traces. The service
 * publishes a trace per state change; the client keeps the latest per
 * run; this view renders that ledger live. Definitions stay files (the
 * workflow service owns them) — this is the observability half Buzz
 * puts in WorkflowCard/RunTrace.
 */

const STATUS_CLASS: Record<string, string> = {
  started: "live",
  step_done: "live",
  step_waiting: "wait",
  waiting_approval: "wait",
  done: "ok",
  approved: "ok",
  failed: "bad",
  denied: "bad",
};

const STATUS_LABEL: Record<string, string> = {
  waiting_approval: "awaiting approval — react 👍 on its message",
  step_waiting: "waiting (delay step)",
  step_done: "running",
  step_skipped: "running (step skipped)",
};

export default function WorkflowsView({ client }: { client: FezClient }) {
  const runs = [...client.workflowRuns().entries()].sort((a, b) => b[1].ts - a[1].ts);

  const ago = (tsMs: number) => {
    const minutes = Math.floor((Date.now() - tsMs) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <main className="main">
      <header className="topbar">
        <div className="topbar-row">» workflows</div>
      </header>
      <div className="timeline">
        {runs.length === 0 && (
          <div className="pane-empty">
            no workflow runs yet — the workflow service executes definitions from ~/.fez/workflows and every run's
            trace lands here live (reply-triggered handoffs, approvals-by-reaction, scheduled steps)
          </div>
        )}
        <div className="pulse-grid">
          {runs.map(([runId, run]) => {
            const cls = STATUS_CLASS[run.status] ?? "live";
            return (
              <div key={runId} className={`wf-card ${cls}`}>
                <div className="wf-head">
                  <span className="wf-name">{run.workflow}</span>
                  <span className={`wf-status ${cls}`}>{run.status.replace(/_/g, " ")}</span>
                </div>
                <div className="wf-detail">
                  {STATUS_LABEL[run.status] ?? run.status.replace(/_/g, " ")}
                  {run.step !== undefined && ` · step ${run.step}`}
                </div>
                <div className="wf-meta">
                  run {runId.slice(0, 8)} · {ago(run.ts)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
