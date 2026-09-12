import type { PageViewProps } from "./gui-extensions";

export type PageOperation =
  | { op: "read_page"; can_edit: boolean; can_read_agents?: boolean }
  | { op: "save_page"; version: string; content: string }
  | { op: "comment_page"; version: string; text: string; anchor: string; mentions: string[] };

export type PageSnapshot = Omit<PageViewProps, "save" | "comment"> & { agents?: [string, string][] | null };

/** The caller can edit only the document whose host created this closure. */
export function createPageHost(current: () => PageViewProps | undefined) {
  let saving = false;
  return async (operation: PageOperation, authorize?: () => Promise<void>): Promise<PageSnapshot | null> => {
    const page = current();
    if (!page) throw Error("Document panel closed");
    if (operation.op === "read_page") {
      return { content: page.content, title: page.title, channelId: page.channelId, slug: page.slug,
        versionId: page.versionId, editable: page.editable && operation.can_edit };
    }
    if (!page.editable) throw Error("This document version is read-only");
    if (!page.versionId || operation.version !== page.versionId) throw Error("The document changed. Review the latest version and try again.");
    if (saving) throw Error("A document change is still saving");
    saving = true;
    const beforePublish = async () => {
      await authorize?.();
      const latest = current();
      if (!latest || !latest.editable) throw Error("Document panel closed or read-only");
      if (latest.versionId !== operation.version) throw Error("The document changed. Review the latest version and try again.");
    };
    try {
      if (operation.op === "save_page") await page.save(operation.content, beforePublish);
      else await page.comment(operation.text, operation.anchor, operation.mentions, beforePublish);
      return null;
    } finally { saving = false; }
  };
}
