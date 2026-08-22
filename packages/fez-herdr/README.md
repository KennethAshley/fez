# @fez/herdr

Register fez personas as herdr-managed terminal tabs, with a clickable sidebar section. herdr supervises the agent process — it survives fez restarts and is attachable in the herdr session — while fez keeps showing it in the rail.

## How

Speaks herdr's newline-JSON socket directly over `node:net`; the sentinel spawns agents as herdr tabs when the socket answers, a detached child otherwise.
