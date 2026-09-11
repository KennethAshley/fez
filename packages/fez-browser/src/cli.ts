#!/usr/bin/env node
import { browserStatus, setupBrowser, testBrowser } from "./runtime.js";

const action = process.argv[2] ?? process.env.FEZ_BROWSER_ACTION ?? "setup";
try {
  if (action === "setup") await setupBrowser();
  else if (action === "test") await testBrowser();
  else if (action !== "status") throw new Error("Expected setup, test or status");
  console.log(JSON.stringify(action === "test" ? { phase: "ready", message: "Browser test passed." } : await browserStatus()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
