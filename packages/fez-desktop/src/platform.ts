/**
 * Which desktop this build runs on, and the words that differ because of it.
 *
 * The webview's user agent is the only signal available synchronously: the
 * Rust side can report the platform only after the page has loaded, which is
 * too late for copy that ships in the first paint.
 */
export const IS_LINUX =
  typeof navigator !== "undefined" &&
  /Linux/.test(navigator.userAgent) &&
  !/Android/.test(navigator.userAgent);

/** What the OS calls the place secrets live. */
export const KEYSTORE = IS_LINUX ? "system keyring" : "macOS keychain";

/** How to name the machine the app runs on. */
export const THIS_MACHINE = IS_LINUX ? "this machine" : "this Mac";

/** What unlocking the store is called when it asks the user. */
export const KEYSTORE_PROMPT = IS_LINUX
  ? "fez keeps your identity in your system keyring. If your keyring is locked, unlock it and try again."
  : "fez keeps your identity in the macOS keychain. If a permission dialog appeared, choose “Always Allow” and try again.";

// Layout that assumes macOS window chrome keys off this attribute; setting it
// here rather than from Rust means it is in place before the first render.
if (IS_LINUX && typeof document !== "undefined") {
  document.documentElement.dataset.platform = "linux";
}
