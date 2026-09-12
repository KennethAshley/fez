import { describe, expect, it } from "vitest";
import miners from "../src/miner-part.js";

describe("Gradients testnet descriptor", () => {
  const d = miners[0];
  it("serves a fixed testnet subnet on a public CPU host", () => {
    expect(miners).toHaveLength(1);
    expect(d).toMatchObject({ netuid: 241, network: "test", requirements: { alwaysOn: true, publicEndpoint: true } });
    expect(d.requirements?.gpu).toBeUndefined();
    expect(d.container?.env).toMatchObject({ NETUID: "241", SUBTENSOR_NETWORK: "test", WALLET_NAME: "default" });
    expect(d.container?.register?.command).toEqual([
      "fiber-post-ip", "--netuid", "241", "--subtensor.network", "test",
      "--external_port", "{servePort}", "--external_ip", "{serveIp}",
      "--wallet.name", "default", "--wallet.hotkey", "{persona}",
    ]);
  });
  it("requires a pinned submission and offers one selected tournament", () => {
    for (const key of ["trainingRepo", "trainingCommit", "tournamentType"]) {
      expect(d.config?.find(f => f.key === key)?.required).toBe(true);
    }
    expect(d.container?.env).toMatchObject({ GRADIENTS_TOURNAMENT_TYPE: "{tournamentType}", GRADIENTS_TRAINING_REPO: "{trainingRepo}", GRADIENTS_TRAINING_COMMIT: "{trainingCommit}" });
    expect(d.config?.some(f => f.key === "subtensorNetwork" || f.key === "walletName")).toBe(false);
    expect(d.container?.mountKeys).toBe(true);
    expect(d.container?.ports).toEqual([{ internal: 7999 }]);
  });
});
