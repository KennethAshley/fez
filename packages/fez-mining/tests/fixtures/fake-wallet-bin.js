#!/usr/bin/env node
// A stand-in for the fez-wallet binary — only what deployHotkey needs
// (export-hotkey --json). Never a real key; just enough shape to exercise
// the copy-onto-the-pod path without touching a keychain.
const [, , cmd, persona] = process.argv;
if (cmd === "export-hotkey") {
  console.log(JSON.stringify({ persona, ss58Address: "5FAKEREMOTE", keyfile: { secretPhrase: "fake" }, created: true }));
  process.exit(0);
}
console.error(`fake-wallet-bin: unsupported command ${cmd}`);
process.exit(1);
