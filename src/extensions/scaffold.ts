/**
 * `fez create <name>` — a working extension in one command.
 *
 * fez is meant to be built on: a feature ships as a package that attaches
 * to the relay, the CLI/sentinel (headless), the desktop (gui), or a
 * workspace provider — never as a patch to core. The fastest way to learn
 * that shape is to start from one that already runs. This writes a package
 * that `fez link`s and loads on the first try, its parts typed against the
 * published contract `@fezchat/extension-api`, so the compiler teaches the API
 * the moment you open the file.
 */
import fs from "node:fs";
import path from "node:path";
import { FEZ_VERSION } from "./host-compat.js";

/** Which host surfaces the new package attaches to. */
export type Surface = "headless" | "gui" | "relay" | "workspace";

export interface ScaffoldOptions {
  /** The name as typed: `todo`, `@you/todo`. */
  name: string;
  /** Where to write it (default `./<basename>`). */
  dir: string;
  /** Surfaces to include (default `["headless", "gui"]`). */
  surfaces: Surface[];
  /** Pinned @fezchat/extension-api range for the generated devDependency. */
  apiVersion: string;
}

export interface ScaffoldResult {
  dir: string;
  pkgName: string;
  files: string[];
  surfaces: Surface[];
}

/** `@you/todo` → `todo`; `todo` → `todo`. The dir and link name. */
export function baseName(name: string): string {
  const tail = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return tail.replace(/^@/, "");
}

/** A JS identifier from a package base name: `todo-app` → `todoApp`. */
function camel(base: string): string {
  return base.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""));
}

/** The union of permissions the chosen surfaces plausibly need — a floor, not a ceiling; trim what you don't use. */
function permissionsFor(surfaces: Surface[]): string[] {
  const set = new Set<string>();
  if (surfaces.includes("gui")) {
    set.add("ui"); // settings panel, decorators, page views…
    set.add("commands"); // registerGuiCommand — the host gates it separately from ui
    set.add("read:channels"); // the host withholds `client` entirely without it
  }
  if (surfaces.includes("headless")) {
    set.add("read:channels");
    set.add("publish");
  }
  if (surfaces.includes("relay")) set.add("read:channels");
  // workspace parts declare nothing extra — they run beside the owner key already.
  return [...set];
}

/** The esbuild invocation for one surface, writing `dist/<surface>.js`. */
function buildStep(surface: Surface): string {
  if (surface === "gui") {
    return "esbuild src/gui.tsx --bundle --format=iife --global-name=__fezExt --platform=browser --jsx=transform --jsx-factory=h --outfile=dist/gui.js";
  }
  return `esbuild src/${surface}.ts --bundle --format=esm --platform=node --packages=external --outfile=dist/${surface}.js`;
}

function packageJson(o: ScaffoldOptions, base: string): string {
  const parts: Record<string, string> = {};
  for (const s of o.surfaces) parts[s] = `dist/${s}.js`;
  const pkg = {
    name: o.name.includes("/") ? o.name : `@you/${base}`,
    version: "0.1.0",
    private: true,
    description: `A fez extension — ${o.surfaces.join(" + ")}.`,
    type: "module",
    fez: {
      type: "extension",
      parts,
      permissions: permissionsFor(o.surfaces),
      // The fez that generated this package is the oldest it promises to
      // work on — install/link refuse on older hosts instead of loading
      // against an API surface that predates the types compiled in.
      minFezVersion: FEZ_VERSION,
    },
    scripts: {
      build: o.surfaces.map(buildStep).join(" && "),
      check: "tsc --noEmit",
    },
    files: ["dist"],
    devDependencies: {
      "@fezchat/extension-api": o.apiVersion,
      esbuild: "^0.21.5",
      typescript: "^5.6.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function tsconfig(surfaces: Surface[]): string {
  const lib = surfaces.includes("gui") ? ["ES2022", "DOM"] : ["ES2022"];
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib,
          noEmit: true,
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
        },
        include: ["src/**/*"],
        exclude: ["node_modules", "dist"],
      },
      null,
      2
    ) + "\n"
  );
}

function headlessStarter(base: string): string {
  const fn = camel(base);
  return `/**
 * ${base} — the HEADLESS part. Runs in the TUI and the always-on
 * sentinel, beside the user's key. This is where slash commands and
 * scheduled work live.
 *
 * The default export is called once with the live API. \`nostr\`,
 * \`channels\`, and \`workspace\` are present only where a key and a relay
 * are — check before you use them, and degrade when they're absent.
 */
import type { FezExtensionAPI } from "@fezchat/extension-api/headless";

export default function ${fn}(api: FezExtensionAPI): void {
  api.registerCommand("${base}", async (args, ctx) => {
    const who = api.nostr ? \` as \${api.nostr.pubkey.slice(0, 8)}…\` : "";
    ctx.reply(args.trim() ? \`${base}: \${args.trim()}\${who}\` : \`${base} is listening\${who}\`);
  });

  // A scheduled task needs the \`background\` permission and only runs in
  // the sentinel. Uncomment and add "background" to fez.permissions to use.
  //
  // api.registerScheduledTask("${base}-tick", 60_000, async (ctx) => {
  //   if (ctx.missedWindow) return; // the machine slept — skip catch-up
  //   // ...do periodic work on behalf of ctx.ownerPubkey
  // });
}
`;
}

function guiStarter(base: string): string {
  const title = base.charAt(0).toUpperCase() + base.slice(1);
  return `/**
 * ${base} — the GUI part. Runs in the desktop webview. The host injects
 * React (\`api.React\`), so this bundle carries none of its own: JSX
 * compiles to \`h(...)\` via the esbuild \`--jsx-factory=h\` in build, and
 * \`h\` is bound to the host's \`createElement\` at activate time.
 */
import type { GuiExtensionApi, El } from "@fezchat/extension-api/gui";

// Bound in activate() — see the build script's --jsx-factory=h.
let h: GuiExtensionApi["React"]["createElement"];
let useState: GuiExtensionApi["React"]["useState"];

export default function activate(api: GuiExtensionApi): void {
  h = api.React.createElement;
  useState = api.React.useState;

  api.registerSettingsPanel("${title}", () => h(Panel, { api }));

  // A composer slash command, returning text posted back to the channel.
  api.registerGuiCommand("${base}", (args) => \`${base}: \${args || "(no args)"}\`);
}

function Panel({ api }: { api: GuiExtensionApi }): El {
  const [n, setN] = useState(0);
  return h(
    "div",
    { style: { padding: "1rem", display: "grid", gap: ".5rem" } },
    h("h3", null, "${title}"),
    h("p", { style: { opacity: 0.7 } }, \`Signed in as \${api.client.pubkey.slice(0, 12)}…\`),
    h("button", { onClick: () => setN((v) => v + 1) }, \`clicked \${n}\`)
  );
}
`;
}

function relayStarter(base: string): string {
  const fn = camel(base);
  return `/**
 * ${base} — the RELAY part. Loaded ONLY by a relay started with
 * \`--extensions\`; it runs inside the store, so keep it dumb and fast.
 * Answer HTTP by claiming a request, and advertise what you added in the
 * relay's NIP-11 doc. The relay holds no signing key: it records and
 * serves, it never speaks — anything said on the network is said by the
 * key-holding side, reading what the relay served.
 */
import type { RelayExtensionAPI } from "@fezchat/extension-api/relay";

export default function ${fn}(api: RelayExtensionAPI): void {
  api.advertise("${base.replace(/-/g, "_")}", { version: 1 });

  api.registerHttpHandler({
    handle(req, res) {
      const r = req as { method?: string; url?: string };
      if (r.method !== "GET" || r.url !== "/${base}/health") return false; // not mine — fall through
      const w = res as { writeHead(code: number, h: Record<string, string>): void; end(body: string): void };
      w.writeHead(200, { "content-type": "application/json" });
      w.end(JSON.stringify({ ok: true, ext: "${base}" }));
      return true;
    },
  });
}
`;
}

function workspaceStarter(base: string): string {
  return `/**
 * ${base} — the WORKSPACE part. A \`repo:\` persona asks the host for a
 * checkout to work in; this provider answers with one. The contract is a
 * single default-exported function:
 *
 *   undefined  → "not mine, try the next provider"
 *   throw      → "mine, and it failed" (must propagate — a silent empty
 *                checkout lets an agent run a whole turn touching nothing)
 *   value      → the checkout the agent runs in, as itself
 */
import type { WorkspaceProvider } from "@fezchat/extension-api/workspace";

const provider: WorkspaceProvider = async (req) => {
  if (!req.repo.startsWith("${base}:")) return undefined; // not mine
  throw new Error("${base}: implement the provider — clone " + req.repo + " into " + req.dir);
};

export default provider;
`;
}

function readme(o: ScaffoldOptions, base: string): string {
  const pkgName = o.name.includes("/") ? o.name : `@you/${base}`;
  return `# ${pkgName}

A fez extension. Attaches to: **${o.surfaces.join(", ")}**.

## Develop

\`\`\`bash
npm install
npm run build          # esbuild → dist/
fez link .             # build, copy parts into ~/.fez, smoke-import
\`\`\`

Then restart the surface it targets — the TUI/sentinel for a headless
part, fez-desktop for a gui part, a \`--extensions\` relay for a relay part.

## Parts

${o.surfaces.map((s) => `- \`src/${s}.${s === "gui" ? "tsx" : "ts"}\` → \`dist/${s}.js\``).join("\n")}

Types come from [\`@fezchat/extension-api\`](https://www.npmjs.com/package/@fezchat/extension-api),
the published contract — the compiler describes exactly what each host
offers. Permissions are declared in \`package.json\` under \`fez.permissions\`
and shown to the user before anything is copied.
`;
}

/** Write the package to disk. Refuses a non-empty target. */
export function scaffold(o: ScaffoldOptions): ScaffoldResult {
  const base = baseName(o.name);
  const dir = path.resolve(o.dir);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error(`${dir} already exists and is not empty`);
  }
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  const write = (rel: string, content: string): string => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return rel;
  };

  const files = [
    write("package.json", packageJson(o, base)),
    write("tsconfig.json", tsconfig(o.surfaces)),
    write("README.md", readme(o, base)),
    write(".gitignore", "node_modules\ndist\n"),
  ];
  const starters: Record<Surface, () => [string, string]> = {
    headless: () => ["src/headless.ts", headlessStarter(base)],
    gui: () => ["src/gui.tsx", guiStarter(base)],
    relay: () => ["src/relay.ts", relayStarter(base)],
    workspace: () => ["src/workspace.ts", workspaceStarter(base)],
  };
  for (const s of o.surfaces) {
    const [rel, content] = starters[s]();
    files.push(write(rel, content));
  }

  return { dir, pkgName: o.name.includes("/") ? o.name : `@you/${base}`, files, surfaces: o.surfaces };
}
