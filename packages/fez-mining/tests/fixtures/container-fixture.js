// A container descriptor that ALSO defines install/register/start — proving
// precedence, not just absence: when `container` is set, the harness must
// never call these script hooks, even though they're right there ready to
// fire if the routing regresses.
export default [{
  netuid: 9996,
  name: "container-fixture",
  requirements: {},
  config: [],
  container: { image: "example/fixture@sha256:0000", env: {}, ports: [] },
  async install(ctx) { await ctx.machine.exec("echo SCRIPT_HOOK_RAN install"); },
  async register(ctx) { await ctx.machine.exec("echo SCRIPT_HOOK_RAN register"); },
  async start(ctx) { await ctx.machine.exec("echo SCRIPT_HOOK_RAN start"); },
}];
