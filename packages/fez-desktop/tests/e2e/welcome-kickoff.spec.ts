import { test, expect } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay, type SpawnedRelay } from "./helpers/relay";
import { BrowserWire } from "../../src/wire";
import { WELCOME_CHANNEL_ID, KIND_MESSAGE } from "../../src/welcome-core";

const PORT = 7777;

/**
 * The hardest GUI test: the post-onboarding welcome choreography, in
 * the browser, against a REAL fez-relay — only the native (Tauri) layer
 * is mocked. Everything else is the real wire: real signatures, real
 * NIP-11 ownership, real subscriptions.
 *
 * start_managed_agent is mocked (no real agents spawn), so no teammate
 * intro ever arrives on its own — this test plays the teammates itself,
 * publishing two intro messages signed by the SAME drift/quill keys
 * ensureStarterTeam rostered (via the dynamic get_identity map below).
 */
test.describe.configure({ mode: "serial" });

test("post-onboarding boot: #welcome opens with hello, opener, summons, intros, kickoff", async ({ page }) => {
  test.setTimeout(150_000);

  const owner = generateSecretKey();
  const agents = { fez: generateSecretKey(), drift: generateSecretKey(), quill: generateSecretKey() };
  const ownerPk = getPublicKey(owner);

  let relay: SpawnedRelay | undefined;
  const teamWires: BrowserWire[] = [];
  try {
    relay = await spawnRelay(PORT, { owner: ownerPk });

    // Account -> hex secret. get_identity is account-keyed (boot asks
    // "default", ensureWelcome/ensureStarterTeam ask "agent:fez",
    // "agent:drift", "agent:quill") — the bridge's dynamic mechanism
    // resolves each lookup for real, inside the browser.
    const identities: Record<string, string> = {
      default: bytesToHex(owner),
      "agent:fez": bytesToHex(agents.fez),
      "agent:drift": bytesToHex(agents.drift),
      "agent:quill": bytesToHex(agents.quill),
    };

    await installMockBridge(
      page,
      {
        get_pubkey: () => ownerPk, // boots as the owner the relay was claimed by
        provider_key_present: () => true, // authed: the choreography must fire
        read_persona: () => "---\nharness: pi\nprovider: local-56105ece7a\nmodel: mock/model-a\neffort: medium\n---\n",
      },
      { identities }
    );

    await page.goto("/");
    await page.evaluate((url) => localStorage.setItem("fez-relay", url), relay.url);
    await page.reload();

    // The app boots as owner, bootstraps #welcome, and @fez speaks.
    await expect(page.getByText("welcome").first()).toBeVisible({ timeout: 15_000 }); // the channel header/sidebar
    await expect(page.getByText(/welcome in/i)).toBeVisible({ timeout: 15_000 }); // hello
    await expect(page.getByText(/I'm @fez, your guide/i)).toBeVisible();
    await expect(page.getByText(/introduce yourself in a sentence or two/i)).toBeVisible({ timeout: 15_000 }); // summons

    // The teammates' intros are REAL turns in production; here the test
    // plays them: publish two intro messages signed by drift/quill —
    // same wire shape as welcome-core's ensureMarkedMessage (tags
    // [["h", id]]), but with NO client marker tag (these aren't
    // scripted lines, they're the "real" turns the app is waiting on).
    const driftWire = new BrowserWire([relay.url], bytesToHex(agents.drift));
    const quillWire = new BrowserWire([relay.url], bytesToHex(agents.quill));
    teamWires.push(driftWire, quillWire);
    await driftWire.publish({
      kind: KIND_MESSAGE,
      tags: [["h", WELCOME_CHANNEL_ID]],
      content: "I'm @drift — I dig up sources and check claims. Bring me anything you need verified.",
    });
    await quillWire.publish({
      kind: KIND_MESSAGE,
      tags: [["h", WELCOME_CHANNEL_ID]],
      content: "I'm @quill — I write and edit, from drafts to tricky wording. Hand me anything that needs to read well.",
    });

    // Prove the intros actually landed and rendered — without this, a
    // broken intro path (identity wiring, introCount matching, publish
    // shape) would still let the test pass via ensureStarterTeam's 120s
    // no-intro backstop, since the kickoff text arrives either way.
    await expect(page.getByText(/I dig up sources and check claims/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/write and edit, from drafts to tricky wording/i)).toBeVisible({ timeout: 15_000 });

    // Tight ceiling: the real intro-triggered path lands the kickoff in
    // ~10s. 45s is generous headroom but still far under the 120s
    // no-intro backstop, so a pass here can only mean the intro path
    // actually fired — not that the test degraded to slow-but-green.
    await expect(page.getByText(/What can we help you build/i)).toBeVisible({ timeout: 45_000 }); // kickoff after intros
  } finally {
    for (const w of teamWires) w.close();
    relay?.kill();
  }
});
