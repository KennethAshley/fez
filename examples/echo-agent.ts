import { Agent } from "@fezchat/protocol";

/**
 * Echo Agent — the simplest possible Fez agent.
 *
 * Run with:
 * ```bash
 * npx tsx examples/echo-agent.ts
 * ```
 *
 * Then test it:
 * ```bash
 * fez send --to <agent-pubkey> --type echo --instruction "Hello world"
 * ```
 */

async function main() {
  const agent = await Agent.create({
    relay: process.env.FEZ_RELAY || "wss://relay.damus.io",
    name: "echo",
    supportedTasks: ["echo"],
    metadata: {
      description: "Echoes back whatever you send",
    },
    privateKey: process.env.FEZ_PRIVATE_KEY,
  });

  agent.onTask(async (task) => {
    console.log(`📨 Received: "${task.content.instruction}"`);

    // Echo back the instruction
    await task.reply({
      status: "success",
      result: {
        echo: task.content.instruction,
        timestamp: new Date().toISOString(),
      },
    });

    console.log(`📤 Replied to ${task.event.pubkey.slice(0, 16)}...`);
  });

  await agent.start();

  // Keep alive
  console.log("Press Ctrl+C to stop");
  process.on("SIGINT", () => {
    agent.stop();
    process.exit(0);
  });
}

main();
