import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import {
  allowedMediaHosts,
  attachmentsOf,
  attachmentNotice,
  fetchAttachment,
} from "../../../src/agent/media.js";

/**
 * What an agent knows about the files in a message, and what it costs to
 * find out.
 *
 * Attachments are DESCRIBED for free and fetched only on request. The
 * description comes from the NIP-92 imeta the sender already wrote — no
 * network — so a channel full of screenshots costs a line of text each
 * instead of megabytes of base64 on every addressed turn. The bytes are
 * spent when the model decides it needs to look, by calling
 * fez_view_attachment.
 *
 * The allowlist still guards every fetch: a channel message is untrusted
 * text, so an arbitrary URL out of it is an SSRF hole whether a human or a
 * model chose to follow it.
 */

const imeta = (url: string, mime?: string, size?: number) =>
  ["imeta", `url ${url}`, ...(mime ? [`m ${mime}`] : []), ...(size ? [`size ${size}`] : [])];

describe("allowedMediaHosts", () => {
  it("always allows the default media server", () => {
    expect(allowedMediaHosts({})).toContain("blossom.primal.net");
  });

  it("unions the configured server with the env spelling", () => {
    const hosts = allowedMediaHosts({
      settingsMediaServer: "https://a.example",
      env: { FEZ_MEDIA_SERVER: "https://b.example" },
    });
    expect(hosts).toContain("a.example");
    expect(hosts).toContain("b.example");
  });

  it("ignores a malformed setting rather than throwing the turn away", () => {
    expect(allowedMediaHosts({ settingsMediaServer: "::: nope :::" })).toContain("blossom.primal.net");
  });
});

describe("attachmentsOf", () => {
  it("reads url, mime and size from imeta without touching the network", () => {
    const found = attachmentsOf({
      content: "📎 shot.png (2.3 MB) https://b.example/abc",
      tags: [["h", "c1"], imeta("https://b.example/abc", "image/png", 2_400_000)],
    });
    expect(found).toEqual([{ url: "https://b.example/abc", mime: "image/png", size: 2_400_000 }]);
  });

  it("finds a bare pasted URL when its host is the workspace's media server", () => {
    const found = attachmentsOf({ content: "look https://b.example/x.png", tags: [] }, new Set(["b.example"]));
    expect(found).toEqual([{ url: "https://b.example/x.png" }]);
  });

  it("an ordinary web link is a link, not an attachment", () => {
    // The view tool only fetches allowlisted media hosts, so offering a
    // docs page or a PR as an "attachment you have NOT seen" sends the
    // model to a guaranteed refusal — and agents telling users they
    // "can't see" plain hyperlinks.
    const found = attachmentsOf(
      { content: "see https://docs.example/page and https://github.com/x/pr/1", tags: [] },
      new Set(["b.example"])
    );
    expect(found).toEqual([]);
  });

  it("without an allowlist, bare urls stay links and only imeta counts", () => {
    const found = attachmentsOf({
      content: "https://elsewhere.example/x.png",
      tags: [imeta("https://b.example/abc", "image/png", 10)],
    });
    expect(found).toEqual([{ url: "https://b.example/abc", mime: "image/png", size: 10 }]);
  });

  it("does not list the same url twice when imeta and the body agree", () => {
    const found = attachmentsOf({
      content: "📎 a.png (1 KB) https://b.example/a.png",
      tags: [imeta("https://b.example/a.png", "image/png", 1024)],
    });
    expect(found).toHaveLength(1);
    expect(found[0].mime).toBe("image/png");
  });

  it("finds nothing in a message that carries nothing", () => {
    expect(attachmentsOf({ content: "just talking", tags: [["h", "c1"]] })).toEqual([]);
  });
});

describe("attachmentNotice", () => {
  it("is absent when there is nothing attached", () => {
    expect(attachmentNotice([])).toBeUndefined();
  });

  it("names the tool for something the model could look at", () => {
    const notice = attachmentNotice([{ url: "https://b.example/a", mime: "image/png", size: 1024 }]);
    expect(notice).toMatch(/fez_view_attachment/);
    expect(notice).toMatch(/https:\/\/b\.example\/a/);
    expect(notice).toMatch(/image\/png/);
  });

  it("tells the truth about audio and video instead of offering the tool", () => {
    const notice = attachmentNotice([{ url: "https://b.example/v", mime: "audio/mp4" }])!;
    expect(notice).toMatch(/cannot|can't/i);
    expect(notice).toMatch(/audio/);
    // Offering a tool that returns "you can't hear this" wastes a turn.
    expect(notice).not.toMatch(/fez_view_attachment.*https:\/\/b\.example\/v/);
  });

  it("offers the tool for an unknown type — only the fetch can say what it is", () => {
    const notice = attachmentNotice([{ url: "https://b.example/hash" }])!;
    expect(notice).toMatch(/fez_view_attachment/);
  });
});

describe("attachmentNotice ceiling", () => {
  it("lists at most a few, and says how many it left out", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://b.example/${i}.png`, mime: "image/png" }));
    const notice = attachmentNotice(many)!;
    // A hostile message with 200 imeta tags must not write 200 urls into
    // the prompt, and must not invite 200 fetches.
    expect(notice.match(/https:\/\/b\.example/g)!.length).toBeLessThanOrEqual(3);
    expect(notice).toMatch(/9 more/);
  });

  it("says nothing about extras when everything fits", () => {
    const notice = attachmentNotice([{ url: "https://b.example/a.png", mime: "image/png" }])!;
    expect(notice).not.toMatch(/more/);
  });
});

describe("fetchAttachment", () => {
  let server: http.Server;
  let host: string;

  const BODIES: Record<string, [string, Buffer]> = {
    "/shot.png": ["image/png", Buffer.from("fake png bytes")],
    "/voice.m4a": ["audio/mp4", Buffer.from("fake m4a bytes")],
    "/notes.pdf": ["application/pdf", Buffer.from("fake pdf")],
    "/huge.png": ["image/png", Buffer.alloc(9 * 1024 * 1024)],
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = (req.url ?? "").split("?")[0];
      if (url === "/away") return res.writeHead(302, { location: "http://evil.example/metadata" }).end();
      if (url === "/here") return res.writeHead(302, { location: "/shot.png" }).end();
      if (url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (url === "/declared-huge.png") {
        // Honest header, oversized: must be refused before a byte is read.
        return res
          .writeHead(200, { "content-type": "image/png", "content-length": String(20 * 1024 * 1024) })
          .end(Buffer.alloc(64));
      }
      if (url === "/lying.png") {
        // Chunked, no length, and it just keeps coming.
        res.writeHead(200, { "content-type": "image/png" });
        for (let i = 0; i < 12; i++) res.write(Buffer.alloc(1024 * 1024));
        return res.end();
      }
      const hit = BODIES[url];
      if (!hit) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": hit[0] }).end(hit[1]);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    host = `127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => server.close());

  const hosts = () => allowedMediaHosts({ settingsMediaServer: `http://${host}` });

  it("returns the bytes for an image, classified by what the server served", async () => {
    const got = await fetchAttachment(`http://${host}/shot.png`, { hosts: hosts() });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.mimeType).toBe("image/png");
    expect(Buffer.from(got.data, "base64").toString()).toBe("fake png bytes");
  });

  it("refuses audio, and says why rather than returning bytes nobody can use", async () => {
    const got = await fetchAttachment(`http://${host}/voice.m4a`, { hosts: hosts() });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/audio/);
  });

  it("refuses a host outside the allowlist without fetching it", async () => {
    const got = await fetchAttachment(`http://${host}/shot.png`, { hosts: allowedMediaHosts({}) });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/media server/i);
  });

  it("refuses something too big to spend a turn's context on", async () => {
    const got = await fetchAttachment(`http://${host}/huge.png`, { hosts: hosts() });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/too large|8/i);
  });

  /**
   * The cap has to bind before the bytes are in memory, not after. Reading
   * the whole body and then measuring it means an allowlisted host — or
   * one it legitimately redirects to — can make the agent buffer whatever
   * it likes; the refusal comes only once the damage is done.
   */
  it("refuses an oversized body without buffering it, on the declared length", async () => {
    const got = await fetchAttachment(`http://${host}/declared-huge.png`, { hosts: hosts() });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/too large/i);
  });

  it("stops reading a body that lies about its length", async () => {
    // No content-length at all, and far more bytes than the cap: the read
    // itself has to give up rather than trusting the header.
    const got = await fetchAttachment(`http://${host}/lying.png`, { hosts: hosts() });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/too large/i);
  });

  it("refuses a type that is not media at all", async () => {
    const got = await fetchAttachment(`http://${host}/notes.pdf`, { hosts: hosts() });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/application\/pdf/);
  });

  /**
   * The allowlist has to survive the redirect, or it guards nothing: an
   * allowlisted host that answers 302 can walk the fetch onto any address
   * — a link-local metadata endpoint included — and the body lands in the
   * model's context as an "image". The default media server is a public
   * one nobody here operates.
   */
  it("does not follow a redirect off the allowlist", async () => {
    const got = await fetchAttachment(`http://${host}/away`, { hosts: hosts() });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/redirect/i);
    expect(got.reason).toMatch(/evil\.example|not this workspace/i);
  });

  it("still follows a redirect that stays on the allowlisted host", async () => {
    const got = await fetchAttachment(`http://${host}/here`, { hosts: hosts() });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.mimeType).toBe("image/png");
  });

  it("gives up rather than chasing a redirect chain", async () => {
    const got = await fetchAttachment(`http://${host}/loop`, { hosts: hosts() });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/redirect/i);
  });
});
