import { useEffect, useState } from "react";
import { subscribe, dismiss, type Toast } from "./toast";

const ICON: Record<Toast["variant"], string> = {
  success: "✓",
  error: "✗",
  warn: "⚠",
  info: "ℹ",
};

/**
 * Rendered once at app root. Stacked bottom-right, newest at the bottom,
 * each toast auto-dismissing (see toast.ts) or closable. Theme-token
 * colored so it reads in light and dark.
 */
export function Toaster() {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  useEffect(() => subscribe(setToasts), []);
  if (toasts.length === 0) return null;
  return (
    <div className="toaster" role="region" aria-label="notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.variant}`} role="status">
          <span className="toast-icon">{ICON[t.variant]}</span>
          <span className="toast-msg">{t.message}</span>
          <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
