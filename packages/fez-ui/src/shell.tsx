import type { ReactNode } from "react";

/**
 * The flex:1 wrapper AgentsPage/SkillsView use so a view fills rail→pane
 * and the pane docks to the window's right edge — without it the
 * measured `.fez-page` (max-width) leaves the leftover width as dead
 * space AFTER the pane.
 */
export function Page({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <main className="main">
      <div className={"fez-page" + (wide ? " wide" : "")}>{children}</div>
    </main>
  );
}

export function PageHeader({
  title,
  subtitle,
  fact,
  action,
}: {
  title: string;
  subtitle?: string;
  fact?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <header className="page-head">
      <h1 className="page-title">{title}</h1>
      {subtitle && <p className="page-sub">{subtitle}</p>}
      {(fact || action) && (
        <div className="page-rule">
          {action && (
            <button className="page-fact page-fact-action" onClick={action.onClick}>
              {action.label}
            </button>
          )}
          {fact && <span className="page-fact">{fact}</span>}
        </div>
      )}
    </header>
  );
}

/** An empty page is an invitation, not an apology — full voice, not a grey italic line. */
export function EmptyState({ line, how }: { line: string; how?: string }) {
  return (
    <div className="page-empty">
      <div className="page-empty-line">{line}</div>
      {how && <div className="page-empty-how">{how}</div>}
    </div>
  );
}
