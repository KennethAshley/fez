import type { HistoryLoadState } from "@fezchat/client";

export default function HistoryStatus({ state, onRetry }: {
  state: Readonly<HistoryLoadState>;
  onRetry: () => void;
}) {
  if (state.status === "loading") {
    return <div className="history-status" role="status">Loading history…</div>;
  }
  if (state.status !== "error") return null;
  return (
    <div className="history-status" role="alert">
      <span>{state.partial
        ? "History is incomplete. Messages already loaded are still available."
        : "Couldn't load history. Check your connection and retry."}</span>
      <button className="agent-action" onClick={onRetry}>Retry</button>
    </div>
  );
}
