/**
 * `fez create <name>` — scaffold a working GUI extension, on-brand from
 * the first file. Emits a package.json/tsconfig/README + a src/view.tsx
 * built from @fezchat/ui, mounted in an isolated native child webview.
 * `fez pack` builds it without additional build configuration.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FEZ_VERSION } from "../extensions/host-compat.js";

function packageJson(name: string): string {
  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    description: `${name} — a fez GUI extension built from @fezchat/ui.`,
    type: "module",
    fez: {
      type: "extension",
      parts: { gui: "dist/view.js" },
      minFezVersion: FEZ_VERSION,
      guiRuntime: "isolated",
      guiContributions: { nav: [{ name, glyph: "◆", label: name }] },
      permissions: ["ui"],
    },
    scripts: {
      build: "fez pack",
      check: "tsc --noEmit",
    },
    dependencies: {
      react: "^19.1.0",
      "react-dom": "^19.1.0",
      "@fezchat/ui": "^0.1.0",
    },
    devDependencies: {
      "@fezchat/protocol": `^${FEZ_VERSION}`,
      "@fezchat/tailwind-preset": "^0.1.0",
      "@fezchat/extension-api": "^0.2.0",
      esbuild: "^0.21.5",
      typescript: "^5.6.0",
      "@types/react": "^19.1.8",
      "@types/react-dom": "^19.1.6",
    },
    files: ["dist"],
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function tsconfig(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          lib: ["ES2022", "DOM"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2
    ) + "\n"
  );
}

function viewTsx(name: string): string {
  const tpl = `import * as React from "react";
import { createRoot } from "react-dom/client";
import { Page, PageHeader, EmptyState } from "@fezchat/ui";
import type { GuiExtensionApi } from "@fezchat/extension-api/gui";

const name = __NAME__;

function App() {
  return (
    <Page wide>
      <PageHeader title={name} subtitle="Your extension, built from @fezchat/ui." fact="ready" />
      <div className="bg-fez-surface text-fez-fg rounded-md p-4">
        <EmptyState line="Nothing here yet." how="Edit src/view.tsx to build your view." />
      </div>
    </Page>
  );
}

// Use only the isolated runtime's supported seams. This view needs UI access only.
export function activate(api: Pick<GuiExtensionApi, "registerNavView">) {
  // The name must match fez.guiContributions.nav in package.json.
  api.registerNavView(name, { glyph: "◆", label: name }, (host) => {
    if (!host) throw new Error("This extension needs a mount-capable Fez desktop.");
    const root = createRoot(host);
    root.render(<App />);
    return () => root.unmount(); // the mount model's disposer
  });
}
`;
  return tpl.replaceAll("__NAME__", JSON.stringify(name));
}

function stylesModuleCss(): string {
  return "/* Optional CSS Module — imported classes are hashed by `fez pack`; prefer fez-* utilities first. */\n";
}

function readme(name: string): string {
  return `# ${name}

A Fez GUI extension built from \`@fezchat/ui\`, running in an isolated
native child webview. Requires a packaged macOS Fez app; \`tauri dev\`
does not support this runtime.

## Develop

\`\`\`sh
npm install
npm run check
npm run build
npx fez link .
\`\`\`

Quit and reopen Fez, then select **${name}** in the navigation rail.
You should see its title, **ready**, and **Nothing here yet.**
Edit \`src/view.tsx\`, run \`npx fez link .\` again, and restart Fez.
\`npx fez link . --watch\` rebuilds and copies on save; restart is still needed.

## The two rules

- Colors come from the \`fez-*\` Tailwind utilities (e.g. \`bg-fez-surface\`,
  \`text-fez-fg\`), never a bare hex — they follow the live theme.
- This starter requests only \`ui\`. When adding data access, declare the
  permission and guard optional capabilities such as \`api.client\`.
  Isolated views support a subset of the GUI API; check the
  [runtime guide](https://docs.fez.chat/extension-api/gui).

## Build

\`npm run build\` bundles \`src/view.tsx\` → \`dist/view.js\` (an IIFE the
isolated child evaluates), hashing any \`*.module.css\` you import.
The CLI is a local dev dependency; a global install is unnecessary.

## Before publishing

Smoke-test the generated view in the packaged app, including reopening it
after switching views. Record the desktop version you tested in this README.
\`fez.minFezVersion\` is the protocol host version, not the desktop release number.
Keep the name in \`fez.guiContributions.nav\` and \`registerNavView\` identical.

Set a scoped package name (\`@you/${name.split("/").pop()}\`), remove
\`"private": true\`, run \`npm run check && npm run build\`, inspect
\`npm pack --dry-run\`, then \`npm publish --access public\`.
Users install with \`fez install @you/${name.split("/").pop()}\`.
`;
}

/**
 * Writes the tree into `outDir` exactly (an exact output dir, not a parent
 * to append `name` to) and returns `outDir` — same `--dir` semantics as
 * the older multi-surface `fez create`, so the flag means one thing
 * regardless of which scaffolder a `create` invocation routes to.
 */
export async function scaffold(name: string, outDir: string): Promise<string> {
  mkdirSync(path.join(outDir, "src"), { recursive: true });
  writeFileSync(path.join(outDir, "package.json"), packageJson(name));
  writeFileSync(path.join(outDir, "tsconfig.json"), tsconfig());
  writeFileSync(path.join(outDir, "src/view.tsx"), viewTsx(name));
  writeFileSync(path.join(outDir, "src/styles.module.css"), stylesModuleCss());
  writeFileSync(path.join(outDir, "README.md"), readme(name));
  return outDir;
}
