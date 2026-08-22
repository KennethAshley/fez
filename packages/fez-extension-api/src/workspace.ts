/**
 * The WORKSPACE-PROVIDER surface — a `workspace` part turns a persona's
 * `repo:` into a working checkout. The contract is one default export:
 *
 *   (request) => Promise<ProvidedWorkspace | undefined>
 *
 * `undefined` means "not mine, try the next provider". THROWING means
 * "mine, and it failed" — which must propagate, because an agent that
 * silently fell back to an empty scratch dir would run a whole turn,
 * touch nothing that matters, and report success.
 */
export interface WorkspaceRequest {
  /** Repo name on the relay. */
  repo: string;
  /** Line to cut the branch from — thread-scoped summons name one. */
  base?: string;
  /** The branch this agent works on — one per agent, so pushes never race. */
  branch: string;
  /** Where to build the checkout. */
  dir: string;
  /** Sparse-checkout cone(s); omit for the whole tree. */
  scope?: string[];
  /** Relay websocket URL — the provider reads its NIP-11 for anything it advertises. */
  relayUrl: string;
  /** The agent's own key, hex — it works AS ITSELF. */
  secretKeyHex: string;
  log?: (line: string) => void;
}

export interface ProvidedWorkspace {
  dir: string;
  branch: string;
  empty: boolean;
}

export type WorkspaceProvider = (req: WorkspaceRequest) => Promise<ProvidedWorkspace | undefined>;
