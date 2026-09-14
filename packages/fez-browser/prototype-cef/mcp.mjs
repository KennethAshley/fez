// Compatibility for previously linked development tools. Implementation belongs to the separate extension.
process.env.FEZ_COMPUTER_USE_SESSION ??= new URL('./agent-session.json', import.meta.url).pathname;
await import('./computer-use/mcp.js');
