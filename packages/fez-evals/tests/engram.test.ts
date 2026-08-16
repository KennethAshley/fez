import { describe, expect, test } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import {
  buildEngramEvent,
  conversationKey,
  engramDTag,
  engramHeads,
  isValidSlug,
  parseBodyStrict,
  selectHead,
  validateEngram,
  type ValidEngram,
} from "@fez/protocol";

/**
 * NIP-AE conformance, anchored to the spec's PINNED TEST VECTORS
 * (buzz docs/nips/NIP-AE.md "Reference test vectors") — passing these
 * means fez and Buzz agents literally share a memory format.
 */
const SK_A = Uint8Array.from(Buffer.from("0000000000000000000000000000000000000000000000000000000000000001", "hex"));
const SK_O = Uint8Array.from(Buffer.from("0000000000000000000000000000000000000000000000000000000000000002", "hex"));
const PK_A = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PK_O = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

describe("spec vectors", () => {
  test("derived pubkeys match", () => {
    expect(getPublicKey(SK_A)).toBe(PK_A);
    expect(getPublicKey(SK_O)).toBe(PK_O);
  });

  test("conversation key is symmetric and matches the pinned K_c", () => {
    const kc = conversationKey(SK_A, PK_O);
    expect(Buffer.from(kc).toString("hex")).toBe("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    expect(Buffer.from(conversationKey(SK_O, PK_A)).toString("hex")).toBe(Buffer.from(kc).toString("hex"));
  });

  test("d-tag derivation matches all three pinned values", () => {
    const kc = conversationKey(SK_A, PK_O);
    expect(engramDTag(kc, "core")).toBe("bdc233238ffe52e272b44cc233c8f33a2bc510b08be04495b225964283be4a90");
    expect(engramDTag(kc, "mem/example")).toBe("72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba");
    expect(engramDTag(kc, "mem/notes/2026-05-12")).toBe("31651571a312780cfdc1f0b706b682ac9f3f51a053e8dca76fe57710bae5a4d4");
  });

  test("spec Event 1 (Buzz-authored bytes) validates and decrypts to body_1", () => {
    const kc = conversationKey(SK_O, PK_A); // deliberately the OWNER's derivation
    const event = {
      kind: 30174,
      pubkey: PK_A,
      created_at: 1700000000,
      tags: [
        ["d", "72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba"],
        ["p", PK_O],
      ],
      content:
        "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABedgcxyfmpph68LBjCWZsTI5lb0Cbg8dIPVYVe/WVj/l4Yd8HGgzC8awyBi9bn9ClRdtd2IPsmont0jN/cajVSQhahTOwuNNwoJtZIg35aSsUzeCq4tQfd8E+fLoKomdPxjs=",
      id: "f4a594177b7aeea4fe99a09efbf74ae85f0126244f322135682c405888a38689",
      sig: "0a4582f0bc5995b9a010afda5984f568055988ebbe4552b4e0ec6d11aeb2b303af940f3d84726a7edd1763badb284eb3aa8457664ceba85a90d6252ed4b494cb",
    };
    const body = validateEngram(event as never, PK_A, PK_O, kc);
    expect(body).toEqual({ slug: "mem/example", value: "hello, agent memory" });
  });
});

describe("slug grammar", () => {
  for (const good of ["core", "mem/example", "mem/notes/2026-05-12", "mem/a", "mem/a_b-c/d0"]) {
    test(`valid: ${good}`, () => expect(isValidSlug(good)).toBe(true));
  }
  for (const bad of ["Core", "mem/", "mem//x", "mem/UPPER", "notes/x", "mem/-leading", "", "mem/a b"]) {
    test(`invalid: ${bad}`, () => expect(isValidSlug(bad)).toBe(false));
  }
});

describe("strict body parse", () => {
  test("rejects duplicate keys (head-selection rule 3)", () => {
    expect(() => parseBodyStrict('{"slug":"core","slug":"core","profile":"x"}')).toThrow(/duplicate/);
  });
  test("rejects nested duplicate keys", () => {
    expect(() => parseBodyStrict('{"slug":"core","profile":"x","extra":{"a":1,"a":2}}')).toThrow(/duplicate/);
  });
  test("same key at different depths is fine", () => {
    expect(parseBodyStrict('{"slug":"core","profile":"x","extra":{"slug":"inner"}}').slug).toBe("core");
  });
  test("colons inside string values are not keys", () => {
    expect(parseBodyStrict('{"slug":"mem/a","value":"note: a, note: b"}').value).toBe("note: a, note: b");
  });
});

describe("head selection + round trip", () => {
  const kc = conversationKey(SK_A, PK_O);
  const sign = (template: ReturnType<typeof buildEngramEvent>) => finalizeEvent(template as never, SK_A);

  test("write → validate round trip; latest wins; tombstone retained as head", () => {
    const v1 = sign(buildEngramEvent(kc, PK_O, { slug: "mem/x", value: "first" }, 1000));
    const v2 = sign(buildEngramEvent(kc, PK_O, { slug: "mem/x", value: "second" }, 2000));
    const grave = sign(buildEngramEvent(kc, PK_O, { slug: "mem/y", value: null }, 3000));
    const core = sign(buildEngramEvent(kc, PK_O, { slug: "core", profile: "I am test agent" }, 1500));
    const heads = engramHeads([v1, v2, grave, core] as never, PK_A, PK_O, kc);
    expect(heads.get("mem/x")?.body.value).toBe("second");
    expect(heads.get("mem/y")?.body.value).toBeNull(); // tombstone IS the head
    expect(heads.get("core")?.body.profile).toBe("I am test agent");
  });

  test("same created_at ties break to lowest id", () => {
    const a = sign(buildEngramEvent(kc, PK_O, { slug: "mem/t", value: "A" }, 5000));
    const b = sign(buildEngramEvent(kc, PK_O, { slug: "mem/t", value: "B" }, 5000));
    const winner = a.id < b.id ? "A" : "B";
    const candidates: ValidEngram[] = [a, b].map((event) => ({
      event: event as never,
      body: { slug: "mem/t", value: event.id === a.id ? "A" : "B" },
    }));
    expect(selectHead(candidates)?.body.value).toBe(winner);
  });

  test("events for a different owner are invalid", () => {
    const stranger = getPublicKey(Uint8Array.from(Buffer.from("03".padStart(64, "0"), "hex")));
    const ev = sign(buildEngramEvent(conversationKey(SK_A, stranger), stranger, { slug: "mem/x", value: "leak?" }, 1000));
    expect(validateEngram(ev as never, PK_A, PK_O, kc)).toBeUndefined();
  });

  test("tampered content fails validation (bad decrypt)", () => {
    const ev = sign(buildEngramEvent(kc, PK_O, { slug: "mem/x", value: "real" }, 1000));
    const tampered = { ...ev, content: ev.content.slice(0, -4) + "AAAA" };
    expect(validateEngram(tampered as never, PK_A, PK_O, kc)).toBeUndefined(); // sig fails first
  });
});
