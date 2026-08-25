import type { ReactNode } from 'react';

/**
 * Qud's panel grammar in fez's light: a horizontal rule broken by a
 * finial, and the half-bracket frame its creatures sit in. Ornament is
 * drawn with characters, not borders — the whole point is that the
 * chrome reads as typed.
 */

export function Rule({ glyph = '▴' }: { glyph?: string }) {
  return (
    <div className="flex items-center gap-2 text-neutral-800" aria-hidden>
      <span className="h-px flex-1 bg-neutral-900" />
      <span className="text-[10px] leading-none text-neutral-700">
        ┤ <span className="text-[#FF6A00]">{glyph}</span> ├
      </span>
      <span className="h-px flex-1 bg-neutral-900" />
    </div>
  );
}

/** The ⌜ ⌝ ⌞ ⌟ corner brackets around a sprite — Qud's specimen frame. */
export function BracketFrame({ children }: { children: ReactNode }) {
  return (
    <span className="relative inline-flex items-center justify-center p-3">
      <span className="pointer-events-none absolute inset-0 text-neutral-700" aria-hidden>
        <span className="absolute left-0 top-0 leading-none">⌜</span>
        <span className="absolute right-0 top-0 leading-none">⌝</span>
        <span className="absolute bottom-0 left-0 leading-none">⌞</span>
        <span className="absolute bottom-0 right-0 leading-none">⌟</span>
      </span>
      {children}
    </span>
  );
}
