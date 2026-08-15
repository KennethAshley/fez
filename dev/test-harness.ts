import { detectHarnesses, findHarness, registerBuiltinHarnesses } from "../src/harness.js";

async function main() {
  registerBuiltinHarnesses();
  console.log("Detecting harnesses...");
  const detected = await detectHarnesses();
  console.log(
    "Detected:",
    detected.map((h) => h.id)
  );

  const claude = findHarness("claude");
  if (!claude) {
    console.error("claude-code harness not detected");
    process.exit(1);
  }

  console.log("Invoking claude-code via ACP...");
  const result = await claude.invoke(
    "Reply with exactly one line: OK",
    process.cwd()
  );
  console.log("Result:", JSON.stringify(result));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
