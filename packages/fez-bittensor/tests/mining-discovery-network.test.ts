import { expect, it, vi } from "vitest";
const endpoints = vi.hoisted(() => [] as string[]);
vi.mock("@polkadot/api", () => ({
  WsProvider: class { constructor(endpoint: string) { endpoints.push(endpoint); } },
  ApiPromise: { create: async () => ({ query: { subtensorModule: {
    networksAdded: { entries: async () => [[{ args: [{ toNumber: () => 241 }] }, { toJSON: () => true }]] },
    subnetIdentitiesV3: { multi: async () => [{ toJSON: () => ({}) }] },
  } } }) },
}));
import { allSubnets } from "../src/subnets.js";

it("uses the requested chain endpoint and keeps testnet identities un-enriched", async () => {
  const result = await allSubnets("wss://test.invalid", false);
  expect(endpoints).toEqual(["wss://test.invalid"]);
  expect(result[0]).toMatchObject({ netuid: 241, name: "subnet 241" });
  await allSubnets("wss://other-test.invalid", false);
  expect(endpoints).toEqual(["wss://test.invalid", "wss://other-test.invalid"]);
});
