import type { El, GuiClient, GuiExtensionApi } from "@fezchat/extension-api/gui";
import { minerRows, statusLine, type MinerRow, type RawEvent } from "./gui-logic.js";

/**
 * The bazaar, seen from the inside.
 *
 * bazaar.fez.chat is the public board — it answers "how is the market doing".
 * This answers the question an operator actually has: "how are MY workers
 * doing out there". It is the client-layer claim made concrete — you do not
 * merely watch the bazaar, you run agents in it from the app you already have.
 *
 * RELAY PATH (settled before this was written): the gui opens its OWN
 * WebSocket to the bazaar relay rather than reading through `client`.
 * fez-wallet learned the hard way that a bare relay pool in a gui part gets
 * silently refused reads on fez's own relays, which are NIP-42 gated and
 * render identically to an empty room. The bazaar relay is the opposite by
 * design — no membership policy, anonymous read and write — and that was
 * verified against live 47003/47020 events before a line of this ran.
 *
 * Styles are inline: a gui part renders through h() and cannot reach App.css,
 * so it borrows that file's vocabulary rather than its rules, the same choice
 * the wallet's ledger makes.
 */

const BAZAAR_RELAY = "wss://bazaar.fez.chat";
const BOARD_URL = "https://bazaar.fez.chat";

/** The cast that mines. A name resolves to a pubkey through the client, so an
 *  agent that is both a workspace member and a miner needs no configuration. */
const FLEET = ["ember", "quill", "forge", "drift"];

const KINDS = { PROFILE: 0, ANNOUNCE: 47000, RESULT: 47003, ATTEST: 47020 } as const;

// fez-desktop's own tokens (App.css) — gruvbox, with the mark held apart.
const INK = "#1d2021";
const SURFACE = "#282828";
const FG = "#ebdbb2";
const DIM = "#928374";
const HAIR = "#32302f";
const BRAND = "#FF6A00";
const ACCENT = "#83a598";

interface Collected {
  profiles: RawEvent[];
  announces: RawEvent[];
  results: RawEvent[];
  attestations: RawEvent[];
}

const empty = (): Collected => ({ profiles: [], announces: [], results: [], attestations: [] });

/** Read the bazaar until EOSE, then keep the socket open for live updates. */
function watchBazaar(onChange: (c: Collected) => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  const collected = empty();

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(BAZAAR_RELAY);
    ws.onopen = () => {
      ws?.send(JSON.stringify(["REQ", "who", { kinds: [KINDS.PROFILE, KINDS.ANNOUNCE], limit: 100 }]));
      ws?.send(JSON.stringify(["REQ", "work", { kinds: [KINDS.RESULT, KINDS.ATTEST], limit: 300 }]));
    };
    ws.onmessage = (m) => {
      let msg: unknown[];
      try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
      if (msg[0] !== "EVENT") return;
      const ev = msg[2] as { kind: number } & RawEvent;
      if (ev.kind === KINDS.PROFILE) collected.profiles.unshift(ev);
      else if (ev.kind === KINDS.ANNOUNCE) collected.announces.unshift(ev);
      else if (ev.kind === KINDS.RESULT) collected.results.push(ev);
      else if (ev.kind === KINDS.ATTEST) collected.attestations.push(ev);
      onChange(collected);
    };
    // A dropped socket is not an empty bazaar — reconnect rather than
    // rendering "no miners", which is what a silent failure would look like.
    ws.onclose = () => { if (!closed) setTimeout(connect, 4000); };
  };
  connect();

  return () => { closed = true; ws?.close(); };
}

export default function bazaar(api: GuiExtensionApi): void {
  const { createElement: h, useState, useEffect, useMemo } = api.React;

  function BazaarView(): El {
    const client = api.client as GuiClient;
    const [collected, setCollected] = useState<Collected>(empty);
    const [tick, setTick] = useState(0);

    // Which of the cast this workspace actually knows. An agent that is both a
    // workspace member and a miner shares one key, so one lookup covers both.
    const mine = useMemo(() => {
      const found: string[] = [];
      for (const name of FLEET) {
        const pk = client.pkByName(name);
        if (pk && !found.includes(pk)) found.push(pk);
      }
      return found;
    }, [tick]);

    useEffect(() => {
      const stop = watchBazaar((c) => setCollected({ ...c }));
      // Re-render on a timer so "not seen recently" becomes true on its own.
      const timer = setInterval(() => setTick((n: number) => n + 1), 30_000);
      return () => { stop(); clearInterval(timer); };
    }, []);

    const rows = minerRows({ ...collected, myPks: mine, now: Date.now() });

    return h("div", { style: { padding: "1.5rem", color: FG, background: INK, minHeight: "100%" } },
      h("div", {
        style: {
          display: "flex", alignItems: "baseline", gap: "0.75rem",
          paddingBottom: "0.5rem", borderBottom: `1px solid ${HAIR}`, marginBottom: "1.25rem",
        },
      },
        h("span", { style: { color: BRAND, textTransform: "uppercase", letterSpacing: "0.14em", fontSize: "0.7rem" } },
          "Your miners"),
        h("span", { style: { color: DIM, fontSize: "0.75rem" } },
          "on the public bazaar"),
        h("a", {
          href: BOARD_URL, target: "_blank", rel: "noreferrer",
          style: { marginLeft: "auto", color: DIM, fontSize: "0.72rem", textDecoration: "none" },
        }, "open the board ↗"),
      ),
      rows.length === 0 ? emptyState() : h("div", {}, ...rows.map(minerRow)),
    );

    function emptyState(): El {
      // The cast holds empty rooms — say what to do, not that there is nothing.
      return h("div", { style: { color: DIM, fontStyle: "italic", lineHeight: 1.7, maxWidth: "44ch" } },
        h("div", {}, "None of your agents are on the bazaar yet."),
        h("div", { style: { marginTop: "0.5rem", fontStyle: "normal", fontSize: "0.8rem" } },
          "The bazaar is a public board where agents answer openly posted work and the judging is public too. ",
          h("a", { href: BOARD_URL, target: "_blank", rel: "noreferrer", style: { color: BRAND } },
            "See who is working now."),
        ),
      );
    }

    function minerRow(r: MinerRow): El {
      const judged = r.tasksScored > 0;
      return h("div", {
        key: r.pk,
        style: {
          display: "flex", gap: "0.85rem", alignItems: "center",
          padding: "0.7rem 0 0.7rem 0.85rem", borderBottom: `1px solid ${HAIR}`,
          position: "relative", background: SURFACE,
        },
      },
        // The leader gets the square ember notch, drawn as an overlay so it
        // never picks up a radius. Nothing else in this view is brand-coloured.
        r.bestRank === 1
          ? h("span", { style: { position: "absolute", left: 0, top: 0, bottom: 0, width: "2px", background: BRAND } })
          : null,
        r.picture
          ? h("img", { src: r.picture, alt: "", width: 30, height: 30, style: { imageRendering: "pixelated", display: "block" } })
          : h("span", { style: { width: "30px" } }),
        h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
          h("div", { style: { color: r.alive ? FG : DIM, fontSize: "0.85rem" } }, r.name),
          h("div", { style: { color: DIM, fontSize: "0.72rem", marginTop: "0.15rem" } }, statusLine(r)),
        ),
        h("div", { style: { textAlign: "right", whiteSpace: "nowrap", fontSize: "0.75rem" } },
          judged
            ? h("div", { style: { color: ACCENT } }, r.avgTotal.toFixed(3))
            : h("div", { style: { color: DIM } }, "—"),
          h("div", { style: { color: DIM, fontSize: "0.7rem", marginTop: "0.15rem" } },
            `spent $${r.spentUsd.toFixed(2)}`),
        ),
      );
    }
  }

  api.registerNavView("Bazaar", { glyph: "◈", label: "Bazaar" }, () => h(BazaarView));
}
