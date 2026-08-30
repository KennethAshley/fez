declare module "@fezchat/media/dist/blossom.js" {
  export interface SignedEvent {
    id: string;
    kind: number;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
    sig: string;
  }

  export interface BlossomUpload {
    url: string;
    sha256: string;
    size: number;
    type?: string;
  }

  export function uploadToBlossom(
    server: string,
    bytes: Uint8Array,
    mime: string,
    sign: (tmpl: { kind: number; tags: string[][]; content: string }) => SignedEvent
  ): Promise<BlossomUpload>;
}
