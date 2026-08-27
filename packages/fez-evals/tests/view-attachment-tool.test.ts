import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The tool half of the on-demand media path.
 *
 * server.ts is an entrypoint — it exits at import when FEZ_AGENT_PERSONA
 * is absent — so this gates its source the way media-server-custody does.
 * The behaviour underneath (allowlist, classification, refusal reasons) is
 * covered directly in agent-media.test.ts against a real HTTP server.
 *
 * What must not drift: the tool exists, it goes through the SHARED
 * allowlist rather than a second copy, and it returns an actual image
 * content block. A tool that returned the url as text would look like it
 * worked and show the model nothing.
 */

const SERVER = path.resolve(__dirname, "../../fez-mcp/src/server.ts");
const source = () => fs.readFileSync(SERVER, "utf8");

describe("fez_view_attachment", () => {
  it("is registered on the server every agent gets", () => {
    expect(source()).toMatch(/registerTool\(\s*"fez_view_attachment"/);
  });

  it("fetches through the shared allowlist, not a private one", () => {
    const s = source();
    expect(s).toMatch(/allowedMediaHosts\(/);
    expect(s).toMatch(/fetchAttachment\(/);
    // The workspace's configured server must reach it, or an agent refuses
    // the very blobs the desktop is uploading.
    expect(s).toMatch(/settingsMediaServer:\s*loadSettings\(\)\.mediaServer/);
  });

  it("returns an image content block, not a description of one", () => {
    expect(source()).toMatch(/type:\s*"image"[\s\S]{0,80}mimeType/);
  });

  it("tells the model why when it can't show something", () => {
    expect(source()).toMatch(/Can't show you that: \$\{got\.reason\}/);
  });
});

/**
 * The agent side must OFFER the tool. An on-demand tool the model is never
 * told about is the same as having no vision at all — and that failure is
 * silent, because the agent simply answers without mentioning the image.
 */
describe("the agent tells the model attachments exist", () => {
  const AGENT = path.resolve(__dirname, "../../fez-acp/src/agent.ts");
  const agent = () => fs.readFileSync(AGENT, "utf8");

  it("builds the attachment notice into the prompt", () => {
    expect(agent()).toMatch(/attachmentNotice\(/);
    expect(agent()).toMatch(/withNotice\(buildPrompt, attachmentPrompt\(/);
  });

  it("no longer fetches images into every turn", () => {
    expect(agent()).not.toMatch(/fetchMessageMedia/);
    expect(agent()).not.toMatch(/withImages/);
  });
});
