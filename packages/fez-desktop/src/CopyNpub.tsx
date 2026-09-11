import { useEffect, useState } from "react";
import { npubForPubkey } from "./public-key";

export default function CopyNpub({ pk, compact = false, className = "" }: {
  pk: string;
  compact?: boolean;
  className?: string;
}) {
  const npub = npubForPubkey(pk);
  const [result, setResult] = useState<{ npub: string; status: "copied" | "error" }>();
  const status = result?.npub === npub ? result?.status : undefined;
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [result]);

  const copy = async () => {
    if (!npub) return;
    try {
      await navigator.clipboard.writeText(npub);
      setResult({ npub, status: "copied" });
    } catch {
      setResult({ npub, status: "error" });
    }
  };

  return (
    <button type="button" className={`npub-copy ${className}`} disabled={!npub}
      aria-label="Copy npub" title={npub ?? "Public key unavailable"} onClick={() => void copy()}>
      <span aria-live="polite">{!npub ? "Public key unavailable"
        : status === "copied" ? "✓ copied"
        : status === "error" ? "Copy failed — try again"
        : compact ? `${npub.slice(0, 12)}…${npub.slice(-8)}` : npub}</span>
    </button>
  );
}
