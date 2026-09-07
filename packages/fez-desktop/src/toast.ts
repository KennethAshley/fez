/**
 * Toasts — one app-wide notification layer, so a message isn't trapped in
 * the pane that fired it. A module-level store (not React context) means
 * any code can `toast.success(...)` without a provider in scope — the
 * <Toaster/> at app root subscribes and renders.
 */
export type ToastVariant = "success" | "error" | "warn" | "info";

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

type Listener = (toasts: readonly Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => {
  const snapshot = [...toasts];
  for (const l of listeners) l(snapshot);
};

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener([...toasts]);
  return () => {
    listeners.delete(listener);
  };
}

export function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Errors linger (you may have looked away); the rest clear on their own. */
const DEFAULT_MS: Record<ToastVariant, number> = { success: 4000, info: 4500, warn: 6000, error: 8000 };

function push(message: string, variant: ToastVariant, ms?: number): number {
  const id = nextId++;
  // Collapse an exact repeat that's still on screen into one — a burst of
  // the same message (a retrying call, a loop) shouldn't stack.
  const dup = toasts.find((t) => t.message === message && t.variant === variant);
  if (dup) return dup.id;
  toasts = [...toasts, { id, message, variant }];
  emit();
  const duration = ms ?? DEFAULT_MS[variant];
  if (duration > 0) setTimeout(() => dismiss(id), duration);
  return id;
}

export const toast = {
  success: (message: string, ms?: number) => push(message, "success", ms),
  error: (message: string, ms?: number) => push(message, "error", ms),
  warn: (message: string, ms?: number) => push(message, "warn", ms),
  info: (message: string, ms?: number) => push(message, "info", ms),
};

/**
 * Drop-in for the old per-pane `flash(text)`: the panes prefix their
 * messages with a glyph (✓ ✗ ⚠), so infer the variant from it and show a
 * clean message. Lets every existing call site become a real toast with
 * one import and no rewrite.
 */
export function flash(text: string): number {
  const t = text.trim();
  const variant: ToastVariant = /^[✓✅]/.test(t)
    ? "success"
    : /^[✗❌]/.test(t)
      ? "error"
      : /^[⚠]/.test(t)
        ? "warn"
        : "info";
  // eslint-disable-next-line no-misleading-character-class -- ℹ️ is ℹ+VS16 on purpose: strip the emoji exactly as senders type it
  return push(t.replace(/^[✓✅✗❌⚠📡📝ℹ️]+\s*/u, ""), variant);
}
