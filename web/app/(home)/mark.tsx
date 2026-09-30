import s from '@/components/light.module.css';

/**
 * The hat the network is named for, in one thin stroke: a flat-topped
 * cone, and a tassel from the crown that sways. Draws itself in on load.
 */
export function FezMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="10 10 110 94" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true" className={`${s.mark} ${className}`}>
      <ellipse cx="60" cy="30" rx="24" ry="6" pathLength={1} />
      <path d="M36 30 L28 94" pathLength={1} />
      <path d="M84 30 L92 94" pathLength={1} />
      <path d="M28 94 A32 8 0 0 0 92 94" pathLength={1} />
      <path d="M29.4 83 A31 7.5 0 0 0 90.6 83" pathLength={1} opacity="0.5" />
      <g className={s.tassel}>
        <path d="M60 30 C72 18 92 20 96 40 L100 66" pathLength={1} />
        <path d="M100 66 L94 88 M100 66 L99 90 M100 66 L104 89 M100 66 L108 86" pathLength={1} />
      </g>
      <circle cx="60" cy="30" r="2.5" fill="#FF6A00" stroke="none" />
    </svg>
  );
}
