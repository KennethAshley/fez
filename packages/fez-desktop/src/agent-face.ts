import { SPRITES } from "@fezchat/ui";

/**
 * Does this agent have a face yet?
 *
 * Two ways to earn one: be in the hand-drawn cast (the name is enough),
 * or have minted a key (the pubkey seeds the generative creature). An
 * agent that is neither has genuinely never worn a face, and the honest
 * answer is to say so.
 *
 * This exists because getting it wrong is worse than the gap it fills:
 * `generateSprite("")` is a perfectly valid creature seeded from an
 * empty string, so a keyless agent rendered through the normal path
 * gets a face — and every keyless agent gets the SAME one. A fabricated
 * identity is a lie the interface tells about who an agent is.
 */
export function hasFace(name: string, pk?: string): boolean {
  return !!SPRITES[name.toLowerCase().replace(/^@/, "")] || !!pk;
}
