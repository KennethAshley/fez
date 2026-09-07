/**
 * One teardown race is not ours to catch: nostr-tools' subscribeMany
 * chains ensureRelay().then(subscribe) with no catch, so a test that
 * closes its wire while that continuation is in flight gets an
 * unhandled SendingOnClosedConnection — a REQ sent to a socket the
 * test just closed, after every assertion has already passed. Vitest
 * (rightly) fails the run on unhandled rejections, so this swallows
 * exactly that library race and nothing else.
 */
process.on("unhandledRejection", (reason) => {
  const name = (reason as { name?: string } | undefined)?.name ?? "";
  const msg = String((reason as { message?: string } | undefined)?.message ?? reason);
  if (name === "SendingOnClosedConnection" || msg.includes("on a closed connection")) return;
  throw reason;
});
