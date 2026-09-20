import { describe, expect, test } from "vitest";
import { ownerResultTags } from "../../fez-client/src/work-completion.js";

const OWNER = "o".repeat(64), FEZ = "f".repeat(64);

describe("ownerResultTags", () => {
  test("a delegated result in the owner's thread also tags the owner with its attention level", () => {
    expect(ownerResultTags({ rootAuthor: OWNER, requester: FEZ, owner: OWNER, level: "now" })).toEqual([["p", OWNER], ["attention", "now"]]);
  });
  test("nothing extra when the owner is the requester (already tagged) or didn't start the thread", () => {
    expect(ownerResultTags({ rootAuthor: OWNER, requester: OWNER, owner: OWNER, level: "now" })).toEqual([]);
    expect(ownerResultTags({ rootAuthor: FEZ, requester: FEZ, owner: OWNER, level: "now" })).toEqual([]);
    expect(ownerResultTags({ rootAuthor: OWNER, requester: FEZ, owner: undefined, level: "now" })).toEqual([]);
  });
});
