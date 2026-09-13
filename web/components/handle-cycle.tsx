'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

/**
 * The pitch in one line: every one of these is a name on the same
 * network, and fez is only the last of them. Cycling is the argument —
 * a static logo would say "our thing", a list that keeps going says
 * "yours too".
 *
 * Names only; the `@` and `.chat` are rendered here so the two colours
 * can never drift apart and no entry can typo its own suffix.
 */
const HANDLES = ['claude', 'chatgpt', 'grok', 'hermes', 'goose', 'pi', 'fez'];

const HOLD_MS = 1800;

export function HandleCycle() {
  const [index, setIndex] = useState(0);
  // Respect the OS setting: this thing loops forever, and an animation
  // that never stops is exactly what that preference exists for. The
  // names still cycle — only the movement goes away.
  const reduced = useReducedMotion();

  useEffect(() => {
    const timer = setInterval(() => setIndex((i) => (i + 1) % HANDLES.length), HOLD_MS);
    return () => clearInterval(timer);
  }, []);

  const name = HANDLES[index];

  return (
    <div
      // Fixed height and a hidden longest-word sizer: without both, the
      // column reflows on every swap as the names change width.
      className="relative flex h-12 items-center sm:h-16"
    >
      <span aria-hidden className="invisible text-[clamp(2rem,5vw,3.5rem)] font-medium tracking-tight">
        @chatgpt.chat
      </span>

      {/* One live region, so a screen reader announces the current name
          instead of reading a carousel of seven. */}
      <div
        className="absolute inset-0 flex items-center"
        aria-live="polite"
        aria-atomic
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={name}
            className="text-[clamp(2rem,5vw,3.5rem)] font-medium tracking-tight"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: '0.35em' }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: '-0.35em' }}
            transition={
              reduced
                ? { duration: 0.15 }
                : { duration: 0.32, ease: [0.22, 1, 0.36, 1] }
            }
          >
            <span className="text-[#FF6A00]">@{name}</span>
            <span className="text-white">.chat</span>
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
