/** One threading shape for ordinary messages from both host channels and bridge outboxes. */
export function channelMessage(opts: { channelId: string; content: string; threadRoot?: string }) {
  return { kind: 47103, content: opts.content, tags: [
    ["h", opts.channelId],
    ...(opts.threadRoot ? [["e", opts.threadRoot, "", "root"]] : []),
  ] };
}
