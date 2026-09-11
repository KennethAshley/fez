import type { FezExtensionAPI as HostAPI } from "../../../src/extensions/extensions.js";
export type { ScheduledTaskContext } from "../../../src/extensions/extensions.js";
export type FezExtensionAPI = Pick<HostAPI, "storage" | "workspace" | "registerScheduledTask">;
