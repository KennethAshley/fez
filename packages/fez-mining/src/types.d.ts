// @fezchat/bittensor ships dist/subnets.js under an exports subpath but no
// .d.ts for it (see src/state.ts's inlined structural Subnet view for the
// same reason). Declare the minimal shape cli.ts actually uses so
// `allSubnets()` type-checks without pulling in the package's full
// (nominally identical, but undeclared) Subnet type.
declare module "@fezchat/bittensor/subnets" {
  export interface Subnet {
    netuid: number;
    name: string;
    description?: string;
    github?: string;
  }
  export function allSubnets(): Promise<Subnet[]>;
}
