import type { FezExtensionAPI } from "./api-types.js";
import { CASES, ROSTER } from "./cases.js";
import { formatFailures, formatScorecard, summarize } from "./core.js";
import { runBench } from "./runner.js";

/**
 * fez-bench, headless part — /bench in any client. Same battery and
 * pipeline as the CLI; results land in the log view. Plug-and-play in
 * the fez-dms mold: benchmarking is a capability over public seams,
 * not a core feature.
 */

const BASE = (process.env.FEZ_ORCHESTRATOR_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");

export default function bench(api: FezExtensionAPI): void {
  api.registerCommand("bench", async (_args, ctx) => {
    ctx.reply(`📏 routing bench: ${CASES.length} cases → ${BASE} (this takes ~a minute)…`);
    try {
      const { results, model, hash } = await runBench(BASE, ROSTER, CASES, (done, total) => {
        if (done % 25 === 0) api.ui.setStatus("bench", `📏 ${done}/${total}`);
      });
      api.ui.setStatus("bench", "");
      const summary = summarize(results);
      api.ui.appendMessage("bench", formatScorecard(summary, model, hash) + "\n\n" + formatFailures(results, 10));
    } catch (err) {
      api.ui.setStatus("bench", "");
      ctx.reply(`📏 ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
