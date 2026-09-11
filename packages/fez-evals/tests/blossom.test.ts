import { afterAll, beforeAll, describe, expect, test } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools/pure";
import { uploadToBlossom, sha256Hex, mimeFor, KIND_BLOSSOM_AUTH } from "../../fez-media/src/blossom.js";

/**
 * Blossom (BUD-02) upload gate: the signed kind-24242 authorization must
 * be verifiable server-side and bound to the exact bytes (x = sha256).
 * The mini server here enforces what a real Blossom server enforces —
 * signature, kind, verb, hash match, unexpired.
 */

let serverUrl: string;
const sk = generateSecretKey();
const sign = (tmpl: { kind: number; tags: string[][]; content: string }) =>
  finalizeEvent({ ...tmpl, created_at: Math.floor(Date.now() / 1000) }, sk);

let server: http.Server;
let lastRejection = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const reject = (code: number, why: string) => {
        lastRejection = why;
        res.writeHead(code).end(why);
      };
      if (req.method !== "PUT" || req.url !== "/upload") return reject(404, "not found");
      const header = req.headers.authorization ?? "";
      if (!header.startsWith("Nostr ")) return reject(401, "missing auth");
      let event;
      try {
        event = JSON.parse(Buffer.from(header.slice(6), "base64").toString());
      } catch {
        return reject(401, "bad auth encoding");
      }
      if (event.kind !== KIND_BLOSSOM_AUTH) return reject(401, "wrong kind");
      if (!verifyEvent(event)) return reject(401, "bad signature");
      const tag = (name: string) => event.tags.find((t: string[]) => t[0] === name)?.[1];
      if (tag("t") !== "upload") return reject(401, "wrong verb");
      const hash = createHash("sha256").update(body).digest("hex");
      if (tag("x") !== hash) return reject(401, "hash mismatch");
      if (Number(tag("expiration")) < Math.floor(Date.now() / 1000)) return reject(401, "expired");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: `${serverUrl}/${hash}`, sha256: hash, size: body.length, type: req.headers["content-type"] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback port");
  serverUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((res) => server.close(() => res())));

describe("Blossom upload", () => {
  test("signed upload round-trips with content-addressed URL", async () => {
    const bytes = new TextEncoder().encode("hello blossom");
    const blob = await uploadToBlossom(serverUrl, bytes, "text/plain", sign);
    expect(blob.sha256).toBe(sha256Hex(bytes));
    expect(blob.url).toContain(blob.sha256);
    expect(blob.size).toBe(bytes.length);
    expect(blob.type).toBe("text/plain");
  });

  test("auth is bound to the exact bytes — a wrong-hash auth is rejected", async () => {
    const bytes = new TextEncoder().encode("real payload");
    const evilSign = (tmpl: { kind: number; tags: string[][]; content: string }) =>
      sign({ ...tmpl, tags: tmpl.tags.map((t) => (t[0] === "x" ? ["x", "0".repeat(64)] : t)) });
    await expect(uploadToBlossom(serverUrl, bytes, "text/plain", evilSign)).rejects.toThrow(/401|hash/);
    expect(lastRejection).toBe("hash mismatch");
  });

  test("unsigned garbage is rejected", async () => {
    const bytes = new TextEncoder().encode("nope");
    const forge = (tmpl: { kind: number; tags: string[][]; content: string }) =>
      ({ ...tmpl, id: "0".repeat(64), pubkey: "0".repeat(64), created_at: Math.floor(Date.now() / 1000), sig: "0".repeat(128) }) as never;
    await expect(uploadToBlossom(serverUrl, bytes, "text/plain", forge)).rejects.toThrow();
    expect(lastRejection).toBe("bad signature");
  });

  test("mime resolution covers the common cases and falls back", () => {
    expect(mimeFor("shot.png")).toBe("image/png");
    expect(mimeFor("notes.md")).toBe("text/markdown");
    expect(mimeFor("weird.blob")).toBe("application/octet-stream");
  });
});
