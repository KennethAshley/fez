import { cloneElement, isValidElement, useId, type MouseEventHandler, type ReactNode } from "react";

/**
 * `.settings-field` > `<label>` + control + `.settings-hint`, the shape
 * every settings screen in the app uses. `htmlFor`/`id` are wired for a11y
 * when `children` is a single element (the common case); a fragment or
 * text child falls back to an unassociated label rather than guessing.
 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const control = isValidElement<{ id?: string }>(children) ? cloneElement(children, { id }) : children;
  return (
    <div className="settings-field">
      <label htmlFor={isValidElement(children) ? id : undefined}>{label}</label>
      {control}
      {hint && <div className="settings-hint">{hint}</div>}
    </div>
  );
}

/**
 * A row that can be the chosen one. There is no generic active-row class
 * in App.css — the ember notch is drawn per-context (`.channel.active`,
 * `.search-row.active`, `.settings-nav-item.active`) — so this emits its
 * own `fez-row` class, and the host document supplies the matching
 * `.fez-row.active::before` notch rule.
 */
export function Row({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      className={"fez-row" + (active ? " active" : "")}
      data-active={active ? "true" : undefined}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

/** `.skill-chip` — the app's own chip, e.g. `.skill-chip.missing` / `.skill-chip.local`. */
export function Chip({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={"skill-chip" + (tone ? ` ${tone}` : "")}>{children}</span>;
}
