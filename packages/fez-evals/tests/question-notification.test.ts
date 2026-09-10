import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "../../fez-desktop/node_modules/@tauri-apps/api/core.js";
import { installNotificationClick, notifyEvent } from "../../fez-desktop/src/notify.js";

vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: vi.fn() }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/window.js", () => ({ getCurrentWindow: () => ({ setFocus: async () => {}, onFocusChanged: async () => () => {} }) }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/plugin-notification/dist-js/index.js", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: vi.fn(), onAction: async () => {} }));
vi.mock("../../fez-desktop/src/sounds.js", () => ({ SOUND_NAMES: [], playSound: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("opens the clicked question even when a newer notification has arrived, and ignores dismissal", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ enabled: true, whileFocused: true, sound: false }) });
  const clicks: ((value: boolean) => void)[] = [];
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => clicks.push(resolve)));
  const navigate = vi.fn();
  installNotificationClick(navigate);
  for (const id of ["first", "second", "dismissed"]) notifyEvent({ key: id, kind: "needs_action", title: "quill needs your input", body: "Open Fez to answer privately.", label: "Questions", target: { kind: "questions", id } });
  await vi.advanceTimersByTimeAsync(1401);
  expect(clicks).toHaveLength(3);
  clicks[0](true);
  await vi.advanceTimersByTimeAsync(0);
  expect(navigate).toHaveBeenLastCalledWith({ kind: "questions", id: "first" });
  clicks[2](false);
  await vi.advanceTimersByTimeAsync(0);
  expect(navigate).toHaveBeenCalledTimes(1);
  clicks[1](true);
  await vi.advanceTimersByTimeAsync(0);
  expect(navigate).toHaveBeenLastCalledWith({ kind: "questions", id: "second" });
});
