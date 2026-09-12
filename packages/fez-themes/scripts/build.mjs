import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";

const { outputFiles } = await build({ entryPoints: ["src/gui.ts"], bundle: true, format: "esm", write: false });
const { default: data } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
await mkdir("dist", { recursive: true });
await writeFile("dist/gui.json", JSON.stringify(data, null, 2) + "\n");
await rm("dist/gui.js", { force: true });
