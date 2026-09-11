import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrowserServer } from "./index.js";
import { createManagedBrowser } from "./runtime.js";

const managed = process.env.CAMOFOX_BASE_URL?.trim() ? undefined : await createManagedBrowser();
const { server, close } = createBrowserServer({
  baseUrl: managed?.baseUrl ?? process.env.CAMOFOX_BASE_URL,
  accessKey: managed?.accessKey ?? process.env.CAMOFOX_ACCESS_KEY,
  prepare: managed?.start,
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  void close().finally(() => managed?.stop()).then(() => process.exit(0), error => {
    console.error(`fez-browser cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
server.server.onclose = shutdown;
await server.connect(new StdioServerTransport());
