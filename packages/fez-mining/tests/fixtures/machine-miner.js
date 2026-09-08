// A SubnetMiner[] whose start proves it went through ctx.machine.
export default [{
  netuid: 9998,
  name: "machine-fixture",
  async start(ctx) {
    const r = await ctx.machine.exec("echo machine-fixture-ran");
    if (r.code !== 0) throw new Error("exec failed");
    ctx.log(`ports: ${JSON.stringify(ctx.machine.ports)}`);
  },
}];
