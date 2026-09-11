import fs from "node:fs/promises";
import path from "node:path";

// A real subprocess at the Camofox boundary; no browser download in the gate.
export async function installedRuntime(root: string) {
  const pkg = path.join(root, "node_modules/@askjo/camofox-browser");
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ type: "module", version: "1.14.0" }));
  await fs.writeFile(path.join(pkg, "camofox.config.json"), JSON.stringify({ plugins: { persistence: { enabled: false }, vnc: { enabled: false } } }));
  const executable = process.platform === "darwin" ? "Camoufox.app/Contents/MacOS/camoufox" : "camoufox-bin";
  await fs.mkdir(path.dirname(path.join(root, "browser", executable)), { recursive: true });
  await fs.writeFile(path.join(root, "browser", executable), "fixture", { mode: 0o755 });
  await fs.writeFile(path.join(root, "browser/version.json"), JSON.stringify({ version: "152.0.4", release: "beta.30" }));
  await fs.writeFile(path.join(pkg, "server.js"), `
    import { createServer } from 'node:http';
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer ' + process.env.CAMOFOX_ACCESS_KEY) { res.writeHead(401).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') res.end(JSON.stringify({ok:true}));
      else if (req.url === '/tabs' && req.method === 'POST') res.end(JSON.stringify({tabId:'check', url:'about:blank'}));
      else if (req.url.startsWith('/sessions/') && req.method === 'DELETE') res.end(JSON.stringify({ok:true}));
      else res.end(JSON.stringify({inheritedSecret:!!process.env.FEZ_BROWSER_TEST_SECRET, host:process.env.CAMOFOX_BIND_HOST, persistence:process.env.CAMOFOX_PROFILE_DIR, apiKeySeparate:process.env.CAMOFOX_API_KEY!==process.env.CAMOFOX_ACCESS_KEY}));
    }).listen(Number(process.env.CAMOFOX_PORT),process.env.CAMOFOX_BIND_HOST);
    process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
  `);
}
