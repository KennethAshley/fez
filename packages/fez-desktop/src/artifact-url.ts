import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/**
 * Stage an artifact document with the Rust side and get an
 * artifact:// URL for an iframe's src. Exists because srcdoc documents
 * inherit the app's CSP — served from their own scheme, artifacts keep
 * their own (permissive) policy while the iframe sandbox does the
 * containment. The doc is released on unmount or content change; a
 * release that loses the race with staging still releases (the stage
 * promise's cleanup handles it), and the Rust side caps the map anyway.
 */
export function useArtifactDoc(html?: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!html) return;
    let released = false;
    let staged: number | undefined;
    void invoke<number>("stage_artifact", { html }).then((id) => {
      if (released) {
        void invoke("release_artifact", { id });
        return;
      }
      staged = id;
      setUrl(convertFileSrc(String(id), "artifact"));
    });
    return () => {
      released = true;
      if (staged !== undefined) void invoke("release_artifact", { id: staged });
    };
  }, [html]);
  return url;
}
