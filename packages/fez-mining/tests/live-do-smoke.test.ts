import { describe, expect, it } from "vitest";
import { doProvision, doAlive, doDestroy } from "../src/machine-do.js";
import { sshMachine } from "../src/machine-ssh.js";
import { ensureDocker } from "../src/container-runner.js";
import { ensureFezSshKey } from "../src/fez-ssh-key.js";

const TOKEN = process.env.FEZ_SMOKE_DO_TOKEN;

describe.skipIf(!TOKEN)("DoMachine live smoke — provision, docker-ready, destroy", () => {
  it("full lifecycle; the droplet is GONE at the end (billing safety is the test)", async () => {
    const identity = await ensureFezSshKey();
    const { ref, ssh } = await doProvision(
      { token: TOKEN!, netuid: 999, persona: "smoke", servePorts: [], publicKey: identity.publicKey, keyPath: identity.keyPath }
    );
    try {
      const m = sshMachine(ssh);
      // cloud-init needs a beat after "active" — retry the probe.
      let up = false;
      for (let n = 0; n < 60 && !up; n++) {
        const r = await m.exec("true", { timeoutMs: 10_000 });
        up = r.code === 0;
        if (!up) await new Promise((res) => setTimeout(res, 5000));
      }
      expect(up).toBe(true);
      // docker may still be installing — poll ensureDocker.
      let dockered = false;
      for (let n = 0; n < 36 && !dockered; n++) {
        dockered = await ensureDocker(m, () => {}).then(() => true, () => false);
        if (!dockered) await new Promise((res) => setTimeout(res, 5000));
      }
      expect(dockered).toBe(true);
    } finally {
      await doDestroy(TOKEN!, ref);
    }
    // The assertion that matters: nothing is billing.
    let alive = true;
    for (let n = 0; n < 24 && alive; n++) {
      alive = await doAlive(TOKEN!, ref);
      if (alive) await new Promise((res) => setTimeout(res, 5000));
    }
    expect(alive).toBe(false);
  }, 900_000);
});
