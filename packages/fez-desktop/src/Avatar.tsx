/**
 * Identicon avatars — fez has no image profiles, and that's fine: the
 * pubkey IS the identity, so the avatar is derived from it. A 5×5
 * symmetric pixel grid (Buzz's BotIdenticon decision, GitHub's shape)
 * colored from the gruvbox accents — deterministic, offline, zero
 * bytes fetched. The same pk renders the same face on every surface.
 */

const PALETTE = ["#83a598", "#b8bb26", "#fabd2f", "#fb4934", "#d3869b", "#8ec07c", "#fe8019"];

function nibble(pk: string, index: number): number {
  return parseInt(pk[index % pk.length] ?? "0", 16) || 0;
}

export default function Avatar({ pk, size = 28, title }: { pk: string; size?: number; title?: string }) {
  const color = PALETTE[nibble(pk, 0) % PALETTE.length];
  const cells: { x: number; y: number }[] = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      if (nibble(pk, 1 + col * 5 + row) % 2 === 0) continue;
      cells.push({ x: col, y: row });
      if (col < 2) cells.push({ x: 4 - col, y: row }); // mirror
    }
  }
  return (
    <svg
      className="avatar"
      width={size}
      height={size}
      viewBox="0 0 7 7"
      role="img"
      aria-label={title ?? "avatar"}
    >
      <title>{title ?? pk.slice(0, 8)}</title>
      <rect x="0" y="0" width="7" height="7" rx="1.4" fill="#32302f" />
      {cells.map((cell, index) => (
        <rect key={index} x={cell.x + 1} y={cell.y + 1} width="1" height="1" fill={color} />
      ))}
    </svg>
  );
}
