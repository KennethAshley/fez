import { basename, relative, isAbsolute } from "node:path";
import type { ErrorEvent, NodeClient } from "@sentry/node";

let client: NodeClient | undefined;

function scrub(text: string): string {
  for (const [name, value] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|PASSWORD|SECRET|DSN|AUTH|COOKIE)/i.test(name) && value && value.length >= 4) text = text.replaceAll(value, "[redacted]");
  }
  return text.replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[key]")
    .replace(/\bnsec1[023456789acdefghjklmnpqrstuvwxyz]+\b/gi, "[key]")
    .slice(0, 1000);
}

/** Keep useful stack locations without sending console history, requests, source text or local variables. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  return {
    type: undefined, event_id: event.event_id, timestamp: event.timestamp, platform: "node", level: event.level,
    environment: event.environment, release: event.release, sdk: event.sdk,
    tags: { component: "fez-node" },
    exception: { values: event.exception?.values?.map(error => ({
      type: scrub(error.type ?? "Error"), value: scrub(error.value ?? ""),
      mechanism: error.mechanism ? { type: error.mechanism.type, handled: error.mechanism.handled } : undefined,
      stacktrace: { frames: error.stacktrace?.frames?.slice(-40).map(frame => {
        const file = frame.filename ?? "";
        const local = relative(process.cwd(), file.replace(/^file:\/\//, ""));
        return {
          filename: scrub(local.startsWith("..") || isAbsolute(local) ? basename(file) : local),
          function: frame.function ? scrub(frame.function) : undefined,
          lineno: frame.lineno, colno: frame.colno, in_app: frame.in_app,
        };
      }) },
    })) },
  };
}

/** A flushed queue can include a rejected event; the connection check requires an actual ingestion acknowledgement. */
export async function verifyConnection(): Promise<string> {
  if (!client) throw Error("Set a valid FEZ_SENTRY_DSN before checking the Sentry connection");
  let status: number | undefined;
  const unsubscribe = client.on("afterSendEvent", (event, response) => {
    if (event.event_id === id) status = response.statusCode;
  });
  const id = client.captureException(new Error("Fez Sentry connection test"));
  try {
    const flushed = await client.flush(5000);
    if (!flushed || status === undefined) throw Error("Sentry did not acknowledge the test event within 5 seconds");
    if (status < 200 || status >= 300) throw Error(`Sentry rejected the test event: HTTP ${status}`);
    return `Sentry accepted test event ${id}`;
  } finally { unsubscribe(); }
}

// Explicit preload + Fez-specific DSN opt in; an unrelated app's SENTRY_DSN must not enable reporting.
const dsn = process.env.FEZ_SENTRY_DSN?.trim();
if (dsn) {
  let valid = false;
  try {
    const url = new URL(dsn);
    valid = (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) &&
      !!url.username && !url.password && !url.search && !url.hash && /\/\d+$/.test(url.pathname);
  } catch { /* Invalid local configuration must not stop Fez from starting. */ }
  if (!valid) console.warn("fez-sentry: invalid FEZ_SENTRY_DSN; error reporting is disabled");
  else {
    const Sentry = await import("@sentry/node");
    client = Sentry.init({
      dsn, environment: process.env.FEZ_SENTRY_ENVIRONMENT || "development",
      release: process.env.FEZ_SENTRY_RELEASE || undefined,
      defaultIntegrations: false,
      // Node's default unhandled-rejection mode already routes fatal rejections through uncaughtException.
      integrations: [Sentry.onUncaughtExceptionIntegration()],
      skipOpenTelemetrySetup: true, registerEsmLoaderHooks: false,
      sendDefaultPii: false, sendClientReports: false, maxBreadcrumbs: 0,
      tracesSampleRate: 0, enableLogs: false, debug: false, spotlight: false,
      beforeSend: (event, hint) => { hint.attachments = []; return scrubEvent(event); },
    });
  }
}
