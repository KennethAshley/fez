export interface DocBlock { text: string; start: number; end: number }
export interface DocumentChange { start: number; end: number; before: string; after: string }
/** Rendered formatting can hide source characters; fall back to complete boundary blocks. */
export function docSelectionRange(first: DocBlock, last: DocBlock, leading: string, trailing: string): { start: number; end: number } {
  const a = leading.trim(), b = trailing.trim();
  const from = a ? first.text.indexOf(a) : -1, to = b ? last.text.indexOf(b) : -1;
  return {
    start: from >= 0 && first.text.indexOf(a, from + 1) < 0 ? first.start + from : first.start,
    end: to >= 0 && last.text.indexOf(b, to + 1) < 0 ? last.start + to + b.length : last.end,
  };
}
/** The changed span, in the new version's coordinates. History retains both full versions. */
export function documentChange(before: string, after: string): DocumentChange | undefined {
  if (before === after) return undefined;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, end = after.length;
  while (oldEnd > start && end > start && before[oldEnd - 1] === after[end - 1]) { oldEnd--; end--; }
  return { start, end, before: before.slice(start, oldEnd), after: after.slice(start, end) };
}

/** The existing commentable Markdown blocks, retaining exact source offsets for quoted selections. */
export function docBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let start: number | undefined, end = 0, offset = 0;
  let fence: string | undefined;
  const flush = () => {
    if (start !== undefined) blocks.push({ text: markdown.slice(start, end), start, end });
    start = undefined;
  };
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      end = offset + line.length;
      if (marker?.[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) {
        fence = undefined; flush();
      }
    } else if (marker) {
      flush(); start = offset; end = offset + line.length; fence = marker;
    } else if (!line.trim()) {
      flush();
    } else if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(line.trim())) {
      flush(); start = offset; end = offset + line.length; flush();
    } else {
      start ??= offset; end = offset + line.length;
    }
    offset += line.length + 1;
  }
  flush();
  return blocks;
}
