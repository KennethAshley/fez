import { describe, expect, it } from "vitest";
import { isPrivateAddress, guardedFetch } from "../src/guard.js";

describe("isPrivateAddress", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.10.10", "::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    it(`refuses ${ip}`, () => expect(isPrivateAddress(ip)).toBe(true));
  }
  for (const ip of ["1.1.1.1", "142.250.80.46", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
    it(`allows ${ip}`, () => expect(isPrivateAddress(ip)).toBe(false));
  }
});

describe("guardedFetch refusals (no network needed)", () => {
  it("refuses non-http schemes", async () => {
    await expect(guardedFetch("ftp://example.com/x")).rejects.toThrow(/http/i);
    await expect(guardedFetch("file:///etc/passwd")).rejects.toThrow(/http/i);
  });
  it("refuses literal private hosts before any DNS", async () => {
    await expect(guardedFetch("http://127.0.0.1:7777/")).rejects.toThrow(/private|internal/i);
    await expect(guardedFetch("http://[::1]/")).rejects.toThrow(/private|internal/i);
    await expect(guardedFetch("http://localhost/")).rejects.toThrow(/private|internal/i);
  });
});
