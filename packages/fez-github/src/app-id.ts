/**
 * The App's identity, shared by the two halves that connect.
 *
 * Its own module because BOTH bundles need it and neither can import
 * the other's: auth.ts runs on node (keychain, subprocesses), gui.ts
 * runs in a webview where `process.env` does not exist. Declaring it
 * twice is how the two would drift apart — the failure this codebase
 * keeps producing (see src/mentions.ts) — so it is declared once, here,
 * with nothing in it that either platform lacks.
 */

/**
 * fez's own GitHub App, checked in on purpose.
 *
 * A device-flow client ID is PUBLIC by design: it travels through the
 * user's own browser during the flow, and GitHub documents it as such.
 * It identifies the app and authorises nothing — holding it grants no
 * access to any repo, because access still needs a token minted only
 * after a human approves the request on github.com, for the repos THEY
 * pick.
 *
 * That is exactly what separates it from a client SECRET, which fez has
 * no way to use: a secret shipped inside a desktop app can be read by
 * anyone holding the app, so any flow that needs one is a flow that
 * lies about being secure. The device flow exists for programs that
 * cannot keep a secret, which is every program that runs on your
 * machine.
 *
 * Point fez at your own App with FEZ_GITHUB_CLIENT_ID — what a company
 * wanting its own name on the consent screen should do.
 */
export const DEFAULT_CLIENT_ID = "Iv23li1j0JDNJ1MncCKt";

/** Where to install or manage the App — the source of truth for what fez can see. */
export const APP_INSTALL_URL = "https://github.com/apps/fez-chat/installations/new";

export interface DeviceCodeLike {
  userCode: string;
  verificationUri: string;
}

/**
 * Where to send the browser, with the code already in the box.
 *
 * The flow always involves a code, and that is its security property
 * rather than an oversight: the token is minted for a request a human
 * approved on GitHub's own page, and nothing can spoof a callback
 * because there is no callback. GitHub takes the code as a query
 * parameter, so the page opens with the field filled and the person
 * clicks Continue. If it ever stops honouring the parameter, they type
 * a code fez has already put on their clipboard.
 */
export function verificationUrl(code: DeviceCodeLike): string {
  try {
    const url = new URL(code.verificationUri);
    url.searchParams.set("user_code", code.userCode);
    return url.toString();
  } catch {
    return "https://github.com/login/device";
  }
}
