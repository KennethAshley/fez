// Mirrored as types in @fezchat/extension-api/manifest; this module has no runtime dependencies.
export interface PageDocumentMatch { fence: string; checklistSections?: number }
export interface IsolatedPageContributions {
  page: { name: string; match: PageDocumentMatch };
  messages?: { linePrefixes: string[]; label: string; summary: string; detailsLabel: string }[];
  blocks?: { language: string; label: string; description?: string; keywords?: string[]; template: string }[];
}

/** Bounded, data-only declarations keep untrusted match/render code out of the host. */
export function parseGuiContributions(value: unknown): IsolatedPageContributions {
  if (JSON.stringify(value)?.length > 32_768) throw Error("GUI contributions exceed 32 KiB");
  const object = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error("Invalid GUI contribution fields");
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, max = 256): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw Error("Invalid GUI contribution text");
    return value;
  };
  const language = (value: unknown) => {
    const result = text(value, 64);
    if (!/^[\w:-]+$/.test(result)) throw Error("Invalid fence language");
    return result;
  };
  const array = (value: unknown, max: number): unknown[] => {
    if (!Array.isArray(value) || value.length > max) throw Error("Invalid GUI contribution list");
    return value;
  };
  const data = object(value, ["page", "messages", "blocks"]);
  const page = object(data.page, ["name", "match"]);
  const match = object(page.match, ["fence", "checklistSections"]);
  const count = match.checklistSections;
  if (count !== undefined && (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10)) throw Error("Invalid section count");
  return {
    page: { name: text(page.name, 80), match: { fence: language(match.fence), ...(count === undefined ? {} : { checklistSections: count as number }) } },
    messages: data.messages === undefined ? [] : array(data.messages, 8).map(value => {
      const message = object(value, ["linePrefixes", "label", "summary", "detailsLabel"]);
      const prefixes = array(message.linePrefixes, 8).map(p => text(p));
      if (!prefixes.length) throw Error("Message summary needs a prefix");
      if (prefixes.some(p => /[\r\n]/.test(p))) throw Error("Message prefixes must fit one line");
      return { linePrefixes: prefixes, label: text(message.label), summary: text(message.summary, 1024), detailsLabel: text(message.detailsLabel) };
    }),
    blocks: data.blocks === undefined ? [] : array(data.blocks, 8).map(value => {
      const block = object(value, ["language", "label", "description", "keywords", "template"]);
      return { language: language(block.language), label: text(block.label), template: text(block.template, 8192),
        ...(block.description === undefined ? {} : { description: text(block.description) }),
        ...(block.keywords === undefined ? {} : { keywords: array(block.keywords, 16).map(k => text(k, 80)) }),
      };
    }),
  };
}

/** Shared with extensions so the host's declaration and headless detection agree. */
export function matchPageDocument(markdown: string, match: PageDocumentMatch): boolean | "default" {
  const escaped = match.fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp("```" + escaped + "\\s*\\n[\\s\\S]*?```", "i").test(markdown)) return "default";
  if (!match.checklistSections) return false;
  let fence: string | undefined;
  let sections = 0, hasTask = false;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (line.trim().startsWith(fence)) fence = undefined; }
    if (fence) continue;
    if (/^##\s+(.+?)\s*$/.test(line)) sections++;
    else if (sections && /^[-*+]\s+\[([ xX])\]\s+/.test(line)) hasTask = true;
  }
  return sections >= match.checklistSections && hasTask;
}
