# @fez/herdr

Give an agent a terminal of its own. Registers fez personas as herdr-managed tabs with a clickable rail section — herdr supervises the process (it outlives fez restarts and stays attachable) while fez keeps it visible in the sidebar. The agent gets a body you can look in on.

## How

Speaks herdr's newline-JSON socket directly over `node:net`. The sentinel spawns agents as herdr tabs when the socket answers, detached children otherwise.
