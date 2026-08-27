import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { allowedMediaHosts, fetchMessageMedia, unperceivedNotice } from "../../fez-acp/src/media.js";

/**
 * What an agent can actually perceive when someone drops a file in a channel.
 *
 * Two failures this guards. First the silent one: the allowlist exists to stop
 * SSRF (a channel message is untrusted text, so fetching arbitrary URLs from it
 * would reach link-local metadata endpoints), but it defaulted to the public
 * Blossom server ONLY — so a person who pointed fez at their own media server
 * had every image silently stop reaching the model, with no log line, because
 * a disallowed host is a bare `continue`.
 *
 * Second the honest one: the model can see images and nothing else. Audio and
 * video have to come back as a stated absence, or the agent answers "what did
 * they say in this clip?" as though the clip were not there.
 */

describe("allowedMediaHosts", () => {
  it("always allows the default media server", () => {
    expect(allowedMediaHosts({})).toContain("blossom.primal.net");
  });

  it("allows the server the user configured in settings.json", () => {
    expect(allowedMediaHosts({ settingsMediaServer: "https://blobs.example.com" })).toContain("blobs.example.com");
  });

  it("allows a bare host with no scheme", () => {
    expect(allowedMediaHosts({ settingsMediaServer: "blobs.example.com" })).toContain("blobs.example.com");
  });

  it("allows the env override too, so both spellings reach the model", () => {
    const hosts = allowedMediaHosts({
      settingsMediaServer: "https://a.example",
      env: { FEZ_MEDIA_SERVER: "https://b.example" },
    });
    expect(hosts).toContain("a.example");
    expect(hosts).toContain("b.example");
  });

  it("ignores a malformed setting rather than throwing the turn away", () => {
    expect(() => allowedMediaHosts({ settingsMediaServer: "::: not a url :::" })).not.toThrow();
    expect(allowedMediaHosts({ settingsMediaServer: "::: not a url :::" })).toContain("blossom.primal.net");
  });
});

describe("fetchMessageMedia", () => {
  let server: http.Server;
  let host: string;

  const BODIES: Record<string, [string, Buffer]> = {
    "/shot.png": ["image/png", Buffer.from("fake png bytes")],
    "/clip.mp4": ["video/mp4", Buffer.from("fake mp4 bytes")],
    "/voice.m4a": ["audio/mp4", Buffer.from("fake m4a bytes")],
    "/notes.pdf": ["application/pdf", Buffer.from("fake pdf bytes")],
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const hit = BODIES[(req.url ?? "").split("?")[0]];
      if (!hit) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": hit[0] }).end(hit[1]);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    host = `127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => server.close());

  const hosts = () => allowedMediaHosts({ settingsMediaServer: `http://${host}` });

  it("hands images to the model as vision", async () => {
    const out = await fetchMessageMedia(`look at this http://${host}/shot.png`, { hosts: hosts() });
    expect(out.images).toHaveLength(1);
    expect(out.images[0].mimeType).toBe("image/png");
    expect(Buffer.from(out.images[0].data, "base64").toString()).toBe("fake png bytes");
  });

  it("reports audio and video as present but unperceived, never as absent", async () => {
    const out = await fetchMessageMedia(
      `📎 voice.m4a (70 KB) http://${host}/voice.m4a and http://${host}/clip.mp4`,
      { hosts: hosts() }
    );
    expect(out.images).toHaveLength(0);
    expect(out.unperceived.map((u) => u.mime).sort()).toEqual(["audio/mp4", "video/mp4"]);
  });

  it("says nothing about formats that were never media", async () => {
    const out = await fetchMessageMedia(`http://${host}/notes.pdf`, { hosts: hosts() });
    expect(out.images).toHaveLength(0);
    expect(out.unperceived).toHaveLength(0);
  });

  it("never fetches a host outside the allowlist", async () => {
    const out = await fetchMessageMedia(`http://127.0.0.1:1/shot.png`, {
      hosts: allowedMediaHosts({}),
    });
    expect(out.images).toHaveLength(0);
    expect(out.unperceived).toHaveLength(0);
  });
});

describe("unperceivedNotice", () => {
  it("is absent when there is nothing to admit", () => {
    expect(unperceivedNotice([])).toBeUndefined();
  });

  it("names the type and tells the agent to say so rather than guess", () => {
    const notice = unperceivedNotice([{ url: "https://b.example/voice.m4a", mime: "audio/mp4" }]);
    expect(notice).toMatch(/audio/);
    expect(notice).toMatch(/cannot|can't/i);
  });
});
