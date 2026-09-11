import { beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { endpointFor } from "../src/networks.js";
import { subtensorFor } from "../src/stake.js";
import { metagraph } from "../src/chains/subtensor.js";
import { metagraphInfo } from "../src/cli-commands.js";
vi.mock("../src/config.js", async original => ({ ...await original<object>(), loadConfig: vi.fn() }));
vi.mock("../src/stake.js", async original => ({ ...await original<object>(), subtensorFor: vi.fn() }));
vi.mock("../src/chains/subtensor.js", async original => ({ ...await original<object>(), metagraph: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
function config(network: "test" | "finney", endpoint = endpointFor(network)) {
  return {network, endpoints:{tao:endpoint}, thresholds:{}, personas:{}, knownPayees:[]};
}
it.each([config("finney"), config("test", "wss://other.example")])("refuses changed networks before connecting", async c => {
  vi.mocked(loadConfig).mockReturnValue(c);
  await expect(metagraphInfo(155,"public",true)).rejects.toThrow(/testnet/);
  expect(subtensorFor).not.toHaveBeenCalled();
});
it("keeps the validated endpoint snapshot when wallet preferences change during connection", async () => {
  const current=config("test");
  vi.mocked(loadConfig).mockImplementation(()=>current);
  vi.mocked(subtensorFor).mockImplementation(async endpoint => {
    expect(endpoint).toBe(endpointFor("test"));
    current.network="finney";
    current.endpoints.tao=endpointFor("finney");
    return {} as Awaited<ReturnType<typeof subtensorFor>>;
  });
  vi.mocked(metagraph).mockResolvedValue(undefined);
  await metagraphInfo(155,"public",true);
  expect(loadConfig).toHaveBeenCalledTimes(1);
  expect(subtensorFor).toHaveBeenCalledWith(endpointFor("test"));
});
