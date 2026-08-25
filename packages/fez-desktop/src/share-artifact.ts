import type { Artifact, FezClient } from "@fezchat/client";
import { toast } from "./toast";

/**
 * Share an artifact to the public web: fez.chat/a/<event-id>.
 *
 * Sharing is EXPLICIT RE-PUBLICATION — the verbatim signed event is
 * POSTed to fez.chat, which schnorr-verifies it and serves it publicly.
 * Nothing is read from the relay by the share page, so this can never
 * become a workspace read-gating bypass: the only thing that goes
 * public is the one event the user chose, and only because they chose.
 */
const SHARE_ENDPOINT = "https://fez.chat/api/artifacts";

export async function shareArtifact(client: FezClient, artifact: Artifact): Promise<void> {
  if (artifact.type === "live") {
    // A live tool reads the workspace through the bridge; a public page
    // has no bridge and no data. Refusing beats shipping a dead frame.
    toast.warn("live tools can't be shared to the web — they read your workspace");
    return;
  }
  if (
    !confirm(
      `Share "${artifact.title ?? artifact.type}" publicly at fez.chat? Anyone with the link can view it.`
    )
  ) {
    return;
  }
  try {
    // The VERBATIM signed event — fez.chat verifies the signature, and a
    // reconstructed copy (new tag order, trimmed field) would be refused.
    const event = await client.fetchEvent(artifact.id);
    if (!event || event.kind !== 40300) {
      toast.error("couldn't fetch the signed artifact back from the relay");
      return;
    }
    const res = await fetch(SHARE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(`share failed: ${body.error ?? `HTTP ${res.status}`}`);
      return;
    }
    const { url } = (await res.json()) as { url: string };
    await navigator.clipboard.writeText(url);
    toast.success("public link copied — anyone can view it now", 6000);
  } catch (err) {
    toast.error(`share failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
