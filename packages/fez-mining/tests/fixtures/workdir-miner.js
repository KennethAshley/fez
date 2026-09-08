// Reports ctx.workDir through ctx.machine.exec (not node:fs) so a remote
// test can see, via the fake-exec call list, exactly what path the harness
// handed the descriptor — proving it's machine-side, not the Mac's home dir.
export default [{
  netuid: 9997,
  name: "workdir-fixture",
  async start(ctx) {
    const r = await ctx.machine.exec(`echo WORKDIR ${ctx.workDir}`, { env: ctx.env });
    if (r.code !== 0) throw new Error("exec failed");
  },
}];
