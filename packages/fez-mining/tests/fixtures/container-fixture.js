// A container descriptor — no install/register/start; the harness must
// route it through docker verbs instead of calling script hooks.
export default [{
  netuid: 9996,
  name: "container-fixture",
  requirements: {},
  config: [],
  container: { image: "example/fixture@sha256:0000", env: {}, ports: [] },
}];
