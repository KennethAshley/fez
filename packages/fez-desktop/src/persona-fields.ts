export function parsePersona(content: string): { front: string[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { front: [], body: content.trim() };
  return { front: match[1].split(/\r?\n/), body: match[2].trim() };
}

export function getField(front: string[], key: string): string {
  // Match the runtime parser: the last occurrence is authoritative.
  for (let i = front.length - 1; i >= 0; i--) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(front[i]);
    if (match) return match[1].trim();
  }
  return "";
}

export function setField(front: string[], key: string, value: string): string[] {
  const matches = (line: string) => line.startsWith(`${key}:`);
  const index = front.findIndex(matches);
  if (!value.trim()) return index === -1 ? front : front.filter(line => !matches(line));
  const line = `${key}: ${value.trim()}`;
  if (index === -1) return [...front, line];
  return front.flatMap((existing, i) => i === index ? [line] : matches(existing) ? [] : [existing]);
}
