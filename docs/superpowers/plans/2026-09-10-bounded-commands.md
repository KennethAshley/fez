# Bounded Commands Implementation Plan

**Goal:** Extension commands and Claude auth probes cannot stall on full or
inherited pipes, retain unlimited output, or silently return partial text.

**Architecture:** One shared Rust runner using nonblocking Unix pipe reads and
the existing libc dependency. Drain stdout and stderr while polling the child;
the same deadline covers execution and pipe EOF. Run each command in its own
process group and terminate that group on completion/error, keeping its leader
unreaped until after group termination so the PID cannot be reused. Keep extension
permissions, argument passing, PATH, and managed-runtime setup unchanged.

**Spec:** Priority 2 in `../research/2026-09-10-buzz-adoption.md`. The user's
“next” authorizes implementation, preserving existing working-tree changes.

**Limits:** 120 seconds / 8 MiB combined output for extension commands; 10
seconds / 1 MiB for auth probes. Overflow and read errors reject the command;
successful output keeps the existing `{code, stdout, stderr}` contract. No
automatic retry of commands that may have side effects.

1. [x] Reproduce noisy auth-probe failure against the existing implementation.
2. [x] Add `src-tauri/src/bounded_command.rs`, route both callers through it,
   and cover concurrent stdout/stderr, output overflow, deadlines, inherited
   pipes, process cleanup, exit codes, and arguments with real child processes.
3. [x] Integrate native regressions into the eval gate without building Tauri
   on platforms lacking desktop libraries. Run Rust tests/check, root
   typecheck, and the full eval suite.
4. [x] Review the final diff, preserve prior edits, and record verification.

## Evidence

- Before the fix, the real auth probe returned false after 10.07 seconds when
  a fixture emitted 256 KiB on stderr before valid signed-in JSON on stdout.
- Nine subprocess regressions run the production Rust module through a tiny
  Cargo test crate in the eval gate, without Tauri's platform dependencies.
  A native integration regression also exercises the actual auth-probe caller.
- Review caught a PID-reuse race caused by reaping before pipe completion.
  The runner now observes exit with `waitid(WNOWAIT)` and reaps only after group
  termination; the pending-leader test checks that ownership remains intact.
- Existing async extension startup and managed-runtime setup edits are preserved.

Final verification: `npm run evals` passed **1,463 tests** (154 files), with one
test/file skipped. Desktop Rust tests passed **79 tests**, with one opt-in
provisioning test ignored. `cargo check`, `cargo build`, root `npx tsc --noEmit`,
and `git diff --check` passed. The suite runs used process/socket permissions
required by existing lifecycle and relay tests; no installed app was replaced.

Primary API reference: [Rust Child::try_wait](https://doc.rust-lang.org/std/process/struct.Child.html#method.try_wait)
documents that exit polling reaps Unix child processes. Process-group setup uses
[CommandExt::process_group](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html#method.process_group).
