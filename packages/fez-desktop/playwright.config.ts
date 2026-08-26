import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    // --host 127.0.0.1: vite preview's default "localhost" binding
    // resolves to IPv6-only on this machine, so the IPv4 baseURL above
    // never connects and Playwright's readiness poll times out.
    command: "npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
