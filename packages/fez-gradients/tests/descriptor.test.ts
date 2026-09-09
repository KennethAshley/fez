import { describe, expect, it } from "vitest";
import miners from "../src/miner-part.js";

describe("gradients descriptor", () => {
  it("declares SN56 with a public-endpoint requirement, no GPU floor", () => {
    expect(miners).toHaveLength(1);
    expect(miners[0]).toMatchObject({
      netuid: 56,
      name: "gradients",
      requirements: { alwaysOn: true, publicEndpoint: true },
    });
    expect(miners[0].requirements?.gpu).toBeUndefined();
  });

  it("declares its config schema — wallet/network/stake/refresh, no LLM provider or secret", () => {
    const keys = miners[0].config?.map((f) => f.key) ?? [];
    expect(keys).toEqual(["walletName", "subtensorNetwork", "minStakeThreshold", "refreshNodes"]);
    expect(miners[0].config?.some((f) => f.type === "secret")).toBe(false);
  });

  it("ships a container descriptor — the image, not install/register/start hooks", () => {
    expect(miners[0].install).toBeUndefined();
    expect(miners[0].register).toBeUndefined();
    expect(miners[0].start).toBeUndefined();
    expect(miners[0].container).toBeDefined();
  });

  it("image is ghcr with a digest placeholder, not a floating tag", () => {
    expect(miners[0].container?.image).toBe("ghcr.io/fezchat/gradients-miner@sha256:REPLACED_AT_PUBLISH");
  });

  it("mounts the bittensor keys read-only", () => {
    expect(miners[0].container?.mountKeys).toBe(true);
  });

  it("publishes the miner's port 7999", () => {
    expect(miners[0].container?.ports).toEqual([{ internal: 7999 }]);
  });

  it("env templates the per-persona config keys, NETUID hardcoded to 56", () => {
    expect(miners[0].container?.env).toEqual({
      WALLET_NAME: "{walletName}",
      HOTKEY_NAME: "{persona}",
      SUBTENSOR_NETWORK: "{subtensorNetwork}",
      NETUID: "56",
      REFRESH_NODES: "{refreshNodes}",
      MIN_STAKE_THRESHOLD: "{minStakeThreshold}",
    });
  });

  it("register runs fiber-post-ip templated with the harness-supplied serve address and persona", () => {
    expect(miners[0].container?.register?.command).toEqual([
      "fiber-post-ip", "--netuid", "56",
      "--subtensor.network", "{subtensorNetwork}",
      "--external_port", "{servePort}", "--external_ip", "{serveIp}",
      "--wallet.name", "{walletName}", "--wallet.hotkey", "{persona}",
    ]);
  });
});
