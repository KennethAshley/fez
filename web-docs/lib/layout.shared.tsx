import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { AnimatedSprite } from '@/components/qud/pixel-sprite';
import { SPRITES } from '@/components/qud/sprites';
import { appName } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    themeSwitch: { enabled: false },
    links: [{ text: "Back to Fez", url: "https://fez.chat", external: true }],
    nav: {
      // The fez creature lives in the manual too — same sprite, same
      // two-frame idle the rest of the site uses. Hover wakes it
      // (sprite-hover machinery already in global.css).
      title: (
        <span className="sprite-hover flex items-center gap-2">
          <AnimatedSprite sprite={SPRITES.fez} scale={2} />
          <span className="font-mono font-semibold text-[--fez-bone]">{appName}</span>
        </span>
      ),
    },
  };
}
