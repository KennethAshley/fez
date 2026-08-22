import { writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import type { RefPolicy } from "./policy.js";

/**
 * Branch protection, relay half — installing the hook that enforces it.
 *
 * The rule itself lives in policy.ts, which is pure so the desktop can
 * show and edit the same thing this enforces. See there for why the
 * policy lives in the repo's channel and why there is no HMAC.
 */

export * from "./policy.js";

/**
 * The pre-receive hook.
 *
 * pre-receive rather than update: it runs once with every ref update on
 * stdin and a non-zero exit rejects the WHOLE push. That is the safer
 * half of the trade — an agent that pushes its branch and `main` in one
 * go gets neither, instead of half a push it now has to reason about.
 *
 * Fail-closed on its own inputs. The relay sets all three variables on
 * every receive-pack, so an unset one does not mean "no policy", it
 * means something went wrong between here and there — and the only safe
 * reading of a missing policy is refusal.
 *
 * The env vars are not secrets and do not need to be. A pubkey is public
 * and the policy is published in a signed channel event; the hook holds
 * no capability an attacker who could read our environment does not
 * already have by virtue of being inside the relay process's blast
 * radius. This is why there is no HMAC here and why Buzz needs one:
 * their hook is talking over a network to a service that must
 * distinguish it from any other caller.
 */
const HOOK = `#!/usr/bin/env bash
# fez pre-receive — written by the relay before every push. Do not edit:
# it is overwritten on each receive-pack so policy changes take effect.
set -uo pipefail
export LC_ALL=C

ZERO=0000000000000000000000000000000000000000

: "\${FEZ_GIT_PUSHER?fez: the relay did not identify the pusher}"
: "\${FEZ_GIT_PROTECT?fez: the relay did not supply a ref policy}"
: "\${FEZ_GIT_PRIVILEGED?fez: the relay did not supply a ref policy}"

status=0
while read -r old new ref; do
    protected=0
    while IFS= read -r pattern; do
        [ -z "$pattern" ] && continue
        case "$ref" in $pattern) protected=1; break;; esac
    done <<< "$FEZ_GIT_PROTECT"
    [ "$protected" = 0 ] && continue

    if [ "$FEZ_GIT_PRIVILEGED" != "1" ]; then
        echo "fez: $ref is protected — push your own branch and open it for merge" >&2
        status=1
        continue
    fi
    if [ "$new" = "$ZERO" ]; then
        echo "fez: $ref is protected — it cannot be deleted" >&2
        status=1
        continue
    fi
    # git sets GIT_OBJECT_DIRECTORY for the quarantine and we inherit it,
    # so merge-base sees the incoming objects without any help from us.
    if [ "$old" != "$ZERO" ] && ! git merge-base --is-ancestor "$old" "$new" 2>/dev/null; then
        echo "fez: $ref is protected — that push is not a fast-forward" >&2
        status=1
        continue
    fi
done
exit $status
`;

/**
 * Write the hook into a bare repo.
 *
 * Called before EVERY push, not once at creation. A hook installed at
 * `git init` time would be right until the day it changed, and repos
 * created before this code existed would never get one — a protection
 * that silently does not apply to your oldest repository is worse than
 * none, because you believe it is there.
 */
export function installHook(repoDir: string): void {
  const dir = path.join(repoDir, "hooks");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pre-receive");
  writeFileSync(file, HOOK, "utf-8");
  chmodSync(file, 0o755);
}

/**
 * Take the hook back out.
 *
 * The hook fails closed on a missing policy, which is right while it is
 * ours to install and catastrophic once it is not: an operator who swaps
 * in a GitAccess without `refPolicy` would leave this file behind, and
 * every push to every repo would be refused by a rule nobody configured.
 * A feature that cannot be turned off is not composed.
 */
export function removeHook(repoDir: string): void {
  rmSync(path.join(repoDir, "hooks", "pre-receive"), { force: true });
}

/** What the hook reads. One place, so the two halves cannot drift. */
export function hookEnv(pubkey: string | undefined, policy: RefPolicy): NodeJS.ProcessEnv {
  return {
    FEZ_GIT_PUSHER: pubkey ?? "anonymous",
    FEZ_GIT_PROTECT: policy.protect.join("\n"),
    FEZ_GIT_PRIVILEGED: policy.privileged ? "1" : "0",
  };
}
