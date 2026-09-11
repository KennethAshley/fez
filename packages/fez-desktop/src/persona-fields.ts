export function parsePersona(content: string): { front: string[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { front: [], body: content.trim() };
  return { front: match[1].split(/\r?\n/), body: match[2].trim() };
}

export function getField(front: string[], key: string): string {
  for (const line of front) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
    if (match) return match[1].trim();
  }
  return "";
}

export function setField(front: string[], key: string, value: string): string[] {
  const index = front.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (!value.trim()) return index === -1 ? front : front.filter((_, i) => i !== index);
  const line = `${key}: ${value.trim()}`;
  if (index === -1) return [...front, line];
  return front.map((existing, i) => (i === index ? line : existing));
}
