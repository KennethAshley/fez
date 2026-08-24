#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * fez-hippius, skill part — decentralized storage on Bittensor subnet 75
 * (Hippius). Hippius exposes S3-compatible storage backed by miners + IPFS,
 * so this is a thin, honest wrapper over the AWS S3 SDK pointed at
 * s3.hippius.com. The decentralization is in WHERE the bytes live (miner
 * nodes, content-addressed), not in how you call it.
 *
 * Credentials are custody: HIPPIUS_ACCESS_KEY / HIPPIUS_SECRET_KEY live in
 * the OS keychain (fez-skill-env), set by the human in secrets, injected
 * here. S3 sub-account keys, not a coldkey — revocable, scoped to storage.
 *
 * Heavy import (the AWS SDK) is deferred to the first tool call, not
 * top-level: a slow import at module load delays the MCP handshake long
 * enough that the harness can give up attaching the server. Same rule the
 * bittensor skill learned with @polkadot/api.
 */

// Europe default; override for US via HIPPIUS_ENDPOINT=https://us-east-1.hippius.com
const ENDPOINT = (process.env.HIPPIUS_ENDPOINT || "https://s3.hippius.com").replace(/\/$/, "");
const ACCESS = process.env.HIPPIUS_ACCESS_KEY;
const SECRET = process.env.HIPPIUS_SECRET_KEY;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const NO_KEY = "No Hippius credentials — set HIPPIUS_ACCESS_KEY and HIPPIUS_SECRET_KEY in Settings → secrets → hippius.";

/** Turn an S3 error into a message that explains the sub-token scope. A
 * Hippius SUB-token can read/write inside GRANTED buckets but can't create
 * buckets or list the whole account — those need the master token / the
 * console. A raw "Access Denied" reads like a bug; this names the cause. */
function s3err(op: string, e: unknown): string {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string };
  if (err?.name === "AccessDenied" || err?.$metadata?.httpStatusCode === 403) {
    return `${op}: access denied. This is likely a scoped SUB-token — it works inside buckets granted to it, but creating buckets or listing all buckets needs the master token (console.hippius.com). Ask an operator to provision + grant a bucket, then work within it.`;
  }
  return `${op} failed: ${String(err?.message ?? e)}`.slice(0, 400);
}

const human = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

// One S3 client, built lazily on first use (defers the AWS SDK import).
let clientPromise: Promise<unknown> | undefined;
async function s3(): Promise<import("@aws-sdk/client-s3").S3Client> {
  if (!clientPromise) {
    clientPromise = import("@aws-sdk/client-s3").then(
      ({ S3Client }) =>
        new S3Client({
          endpoint: ENDPOINT,
          region: "decentralized",
          credentials: { accessKeyId: ACCESS!, secretAccessKey: SECRET! },
          forcePathStyle: true,
        })
    );
  }
  return clientPromise as Promise<import("@aws-sdk/client-s3").S3Client>;
}

const server = new McpServer({ name: "fez-hippius", version: "0.1.0" });

server.registerTool(
  "hippius_buckets",
  { description: "List your Hippius (Bittensor subnet 75) storage buckets.", inputSchema: {} },
  async () => {
    if (!ACCESS || !SECRET) return text(NO_KEY);
    try {
      const { ListBucketsCommand } = await import("@aws-sdk/client-s3");
      const out = await (await s3()).send(new ListBucketsCommand({}));
      const names = (out.Buckets ?? []).map((b) => b.Name).filter(Boolean) as string[];
      return text(names.length ? `${names.length} bucket(s):\n${names.map((n) => `- ${n}`).join("\n")}` : "no buckets visible (a sub-token only sees buckets granted to it — ask for a grant, or use hippius_list on a known bucket).");
    } catch (e) {
      return text(s3err("list-buckets", e));
    }
  }
);

server.registerTool(
  "hippius_create_bucket",
  {
    description: "Create a new Hippius storage bucket (decentralized, S3-compatible).",
    inputSchema: { bucket: z.string().describe("Bucket name (S3 naming: lowercase, no spaces).") },
  },
  async ({ bucket }) => {
    if (!ACCESS || !SECRET) return text(NO_KEY);
    try {
      const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
      await (await s3()).send(new CreateBucketCommand({ Bucket: bucket }));
      return text(`✅ created bucket "${bucket}" on Hippius.`);
    } catch (e) {
      return text(s3err("create-bucket", e));
    }
  }
);

server.registerTool(
  "hippius_list",
  {
    description: "List objects stored in a Hippius bucket, with sizes.",
    inputSchema: {
      bucket: z.string().describe("The bucket to list."),
      prefix: z.string().optional().describe("Optional key prefix filter (a 'folder')."),
    },
  },
  async ({ bucket, prefix }) => {
    if (!ACCESS || !SECRET) return text(NO_KEY);
    try {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const out = await (await s3()).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      const items = (out.Contents ?? []).map((o) => `- ${o.Key} (${human(o.Size ?? 0)})`);
      return text(items.length ? `${items.length} object(s) in ${bucket}${prefix ? `/${prefix}` : ""}:\n${items.join("\n")}` : `no objects in ${bucket}${prefix ? ` under ${prefix}` : ""}.`);
    } catch (e) {
      return text(`Hippius list failed: ${String((e as Error)?.message ?? e)}`.slice(0, 400));
    }
  }
);

server.registerTool(
  "hippius_upload",
  {
    description:
      "Store data in a Hippius bucket (decentralized, content-addressed). For text/JSON content, or a local file path to upload.",
    inputSchema: {
      bucket: z.string().describe("Target bucket."),
      key: z.string().describe("Object key (its name/path in the bucket)."),
      content: z.string().optional().describe("Inline text/JSON content to store."),
      file_path: z.string().optional().describe("Absolute path of a local file to upload instead of inline content."),
      content_type: z.string().optional().describe("MIME type (default text/plain, or inferred)."),
    },
  },
  async ({ bucket, key, content, file_path, content_type }) => {
    if (!ACCESS || !SECRET) return text(NO_KEY);
    if (!content && !file_path) return text("Provide either `content` (inline) or `file_path` (a local file) to upload.");
    try {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      let body: Uint8Array | string;
      let type = content_type;
      if (file_path) {
        const fs = await import("node:fs/promises");
        body = new Uint8Array(await fs.readFile(file_path));
        type = type ?? "application/octet-stream";
      } else {
        body = content!;
        type = type ?? "text/plain";
      }
      await (await s3()).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: type }));
      return text(`✅ stored ${bucket}/${key} (${human(body.length)}) on Hippius. Fetch it with hippius_download or share it with hippius_share.`);
    } catch (e) {
      return text(`Hippius upload failed: ${String((e as Error)?.message ?? e)}`.slice(0, 400));
    }
  }
);

server.registerTool(
  "hippius_download",
  {
    description: "Fetch an object's contents from a Hippius bucket (returns text; use hippius_share for binaries).",
    inputSchema: {
      bucket: z.string().describe("Source bucket."),
      key: z.string().describe("Object key to fetch."),
    },
  },
  async ({ bucket, key }) => {
    if (!ACCESS || !SECRET) return text(NO_KEY);
    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const out = await (await s3()).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bodyText = await out.Body?.transformToString();
      return text(`${bucket}/${key}:\n\n${(bodyText ?? "").slice(0, 8000)}`);
    } catch (e) {
      return text(`Hippius download failed: ${String((e as Error)?.message ?? e)}`.slice(0, 400));
    }
  }
);

server.registerTool(
  "hippius_share",
  {
    description: "Create a temporary shareable link (presigned URL) to a Hippius object — no credentials needed to open it.",
    inputSchema: {
      bucket: z.string().describe("Source bucket."),
      key: z.string().describe("Object key to share."),
      expires_seconds: z.number().optional().describe("Link lifetime in seconds (default 3600)."),
    },
  },
  async ({ bucket, key, expires_seconds }) => {
    if (!ACCESS || !SECRET) return text(NO_KEY);
    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const url = await getSignedUrl(await s3(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expires_seconds ?? 3600,
      });
      return text(`🔗 ${bucket}/${key} (expires in ${(expires_seconds ?? 3600) / 60} min):\n${url}`);
    } catch (e) {
      return text(`Hippius share failed: ${String((e as Error)?.message ?? e)}`.slice(0, 400));
    }
  }
);

await server.connect(new StdioServerTransport());
console.error(`fez-hippius ready — storage over ${ENDPOINT}${ACCESS && SECRET ? "" : " (no keys yet — set HIPPIUS_ACCESS_KEY/HIPPIUS_SECRET_KEY in secrets)"}`);
