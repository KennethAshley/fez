'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState('');
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: resolvedTheme === 'dark' ? 'dark' : 'neutral',
        fontFamily: 'inherit',
      });
      const { svg } = await mermaid.render(
        id.replace(/[^a-zA-Z0-9]/g, ''),
        chart.replaceAll('\\n', '\n'),
      );
      if (!cancelled) setSvg(svg);
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  return (
    <div
      className="my-6 flex justify-center overflow-x-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
