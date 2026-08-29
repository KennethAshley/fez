/**
 * `fez create <name>` — scaffold a working GUI extension, on-brand from
 * the first file. Emits a package.json/tsconfig/README + a src/view.tsx
 * built from @fezchat/ui (Page/PageHeader/EmptyState) that mounts via
 * `registerNavView`'s `(host) => Dispose` shape and guards `api.client`
 * (absent-when-ungranted) instead of assuming it. `fez pack` (Task 6)
 * builds it straight away — no fez-specific build config to learn.
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
    },
    scripts: {
      build: "fez pack",
    },
    dependencies: {
      react: "^19.1.0",
      "react-dom": "^19.1.0",
      "@fezchat/ui": "^0.1.0",
    },
    devDependencies: {
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

/** The Task-7-brief template, verbatim except for __NAME__ substitution. */
function viewTsx(name: string): string {
  const tpl = `import * as React from "react";
import { createRoot } from "react-dom/client";
import { Page, PageHeader, EmptyState } from "@fezchat/ui";
import type { GuiExtensionApi } from "@fezchat/extension-api/gui";

function App({ api }: { api: GuiExtensionApi }) {
  // api.client is absent when the read:channels grant was declined — guard,
  // never assert. Colors come from fez-* utilities, never a bare hex.
  if (!api.client) {
    return <Page><PageHeader title="__NAME__" subtitle="Grant channel access to see your data." /></Page>;
  }
  return (
    <Page wide>
      <PageHeader title="__NAME__" subtitle="Your extension, built from @fezchat/ui." fact="ready" />
      <div className="bg-fez-surface text-fez-fg rounded-md p-4">
        <EmptyState line="Nothing here yet." how="Edit src/view.tsx to build your view." />
      </div>
    </Page>
  );
}

export function activate(api: GuiExtensionApi) {
  api.registerNavView("__NAME__", { glyph: "◆", label: "__NAME__" }, (host) => {
    const root = createRoot(host!);
    root.render(<App api={api} />);
    return () => root.unmount(); // the mount model's disposer
  });
}
`;
  return tpl.replaceAll("__NAME__", name);
}

function stylesModuleCss(): string {
  return "/* Optional CSS Module — imported classes are hashed by `fez pack`; prefer fez-* utilities first. */\n";
}

function readme(name: string): string {
  return `# ${name}

A fez GUI extension scaffolded by \`fez create\`, built from \`@fezchat/ui\`.

## The two rules

- Colors come from the \`fez-*\` Tailwind utilities (e.g. \`bg-fez-surface\`,
  \`text-fez-fg\`), never a bare hex — they follow the live theme.
- \`api.*\` capabilities are absent when their permission was declined
  (see \`api.client\` in \`src/view.tsx\`) — guard them, never assert.

## Build

\`\`\`
fez pack
\`\`\`

bundles \`src/view.tsx\` → \`dist/view.js\` (an IIFE the desktop loader
evaluates), hashing any \`*.module.css\` you import along the way.
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
