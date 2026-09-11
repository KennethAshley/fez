import { afterEach, expect, it, vi } from "vitest";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { createRequire } from "node:module";
const requireSpeech = createRequire(new URL("../../fez-elevenlabs/src/mcp.ts", import.meta.url));

const state = vi.hoisted(() => ({
  speak: undefined as undefined | ((input: { channel: string; text: string }) => Promise<{ content: { text: string }[] }>),
  published: [] as Event[],
  audio: undefined as Uint8Array | undefined,
  mime: "",
}));
vi.doMock(requireSpeech.resolve("@modelcontextprotocol/sdk/server/mcp.js").replace("/dist/cjs/", "/dist/esm/"), () => ({ McpServer: class {
  registerTool(_name: string, _schema: unknown, handler: typeof state.speak) { state.speak = handler; }
  async connect() {}
} }));
vi.mock("@fezchat/protocol", () => ({
  getKey: () => "11".repeat(32), resolveRelays: () => ["ws://localhost:7777"], loadSettings: () => ({}),
  RelayConnection: class {
    async query() { return [{ tags: [["d", "demo"], ["name", "demo"]], content: "" }]; }
    async publish(event: Event) { state.published.push(event); }
  },
}));
vi.doMock(requireSpeech.resolve("@fezchat/media/dist/blossom.js"), () => ({
  uploadToBlossom: async (_server: string, bytes: Uint8Array, mime: string) => {
    state.audio = bytes; state.mime = mime;
    return { url: "https://media.example/speech.wav", size: bytes.length, type: mime };
  },
}));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function load(engine?: string) {
  vi.resetModules();
  state.published = []; state.audio = undefined; state.mime = "";
  vi.stubEnv("FEZ_AGENT_PERSONA", "speaker");
  vi.stubEnv("ELEVENLABS_API_KEY", "");
  vi.stubEnv("FEZ_SPEECH_ENGINE", engine ?? "");
  // An accidental cloud call must fail even if credentials exist on a developer's machine.
  vi.stubGlobal("fetch", () => { throw new Error("unexpected cloud synthesis"); });
  await import("../../fez-elevenlabs/src/mcp.js");
  return state.speak!;
}

it.skipIf(process.platform !== "darwin")("local speech delivers real WAV bytes and a signed audio message with a returnable URL, without an API key", async () => {
  const speak = await load("macos");
  const result = await speak({ channel: "#demo", text: "Hello from Fez." });
  expect(result.content[0].text).toContain("https://media.example/speech.wav");
  expect(state.mime).toBe("audio/wav");
  expect(Buffer.from(state.audio!).subarray(0, 4).toString()).toBe("RIFF");
  expect(state.audio!.length).toBeGreaterThan(1000);
  expect(state.published).toHaveLength(1);
  const event = state.published[0];
  expect(verifyEvent(event)).toBe(true);
  expect(event.kind).toBe(47103);
  expect(event.content).toBe("Hello from Fez.");
  expect(event.tags).toContainEqual(["h", "demo"]);
  expect(event.tags.find(t => t[0] === "imeta")).toContain("m audio/wav");
}, 30_000);

it("keeps ElevenLabs as the default and reports missing credentials without posting", async () => {
  const speak = await load();
  expect((await speak({ channel: "demo", text: "Hello." })).content[0].text).toContain("ELEVENLABS_API_KEY");
  expect(state.published).toHaveLength(0);
});

it("rejects an unknown engine and oversized requests without generating or posting audio", async () => {
  const speak = await load("typo");
  expect((await speak({ channel: "demo", text: "Hello." })).content[0].text).toMatch(/unknown.*engine/i);
  const local = await load("macos");
  expect((await local({ channel: "demo", text: "x".repeat(2501) })).content[0].text).toContain("2500");
  expect(state.audio).toBeUndefined();
  expect(state.published).toHaveLength(0);
});
