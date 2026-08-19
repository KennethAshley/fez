/**
 * @fez/bittensor, gui part — loaded by fez-desktop from ~/.fez/gui-extensions.
 *
 * The webview has no process.env and no Docker: heavy lifting (miners,
 * repo inspection) stays with the headless part and the standalone agent.
 * What belongs in the GUI:
 *   - /bittensor in the composer: fetch taostats dev activity and POST the
 *     report into the channel — it goes over the wire, so agents and other
 *     clients see the same data the card renders.
 *   - a message decorator that renders any "⛏️ bittensor subnets" report
 *     (from this command, the TUI, or an agent) as a card.
 *
 * The taostats key is per-machine (localStorage) — set it once with
 * /bittensor key <api-key>. It is never posted to the channel.
 */

interface SubnetRow {
  netuid: number;
  daysSince?: number;
  commits?: number;
  devs?: number;
  repo: string;
}

interface GuiApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React: { createElement: (...args: any[]) => unknown };
  client: {
    state: { scope?: { channelId: string } };
    sendChannelMessage(text: string, opts?: object): Promise<unknown>;
  };
  registerMessageDecorator(
    match: (content: string) => boolean,
    render: (props: { content: string }) => unknown
  ): void;
  registerGuiCommand(name: string, run: (args: string) => Promise<string> | string): void;
}

declare const localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };

const KEY_SLOT = "fez-taostats-key";
const REPORT_PREFIX = "⛏️ bittensor subnets";
/** SN64 · 0d · 42c/30d · 7dev · https://github.com/x/y */
const ROW_RE = /^SN(\d+) · (\d+|\?)d · (\d+|\?)c\/30d · (\d+|\?)dev · (\S+)$/;

function parseReport(content: string): SubnetRow[] {
  const rows: SubnetRow[] = [];
  for (const line of content.split("\n").slice(1)) {
    const m = ROW_RE.exec(line.trim());
    if (!m) continue;
    const num = (s: string) => (s === "?" ? undefined : Number(s));
    rows.push({ netuid: Number(m[1]), daysSince: num(m[2]), commits: num(m[3]), devs: num(m[4]), repo: m[5] });
  }
  return rows;
}

async function fetchSubnets(apiKey: string): Promise<SubnetRow[]> {
  const res = await fetch("https://api.taostats.io/api/dev_activity/latest/v1?per_page=50", {
    headers: { Authorization: apiKey, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`taostats ${res.status}`);
  const data = (await res.json()) as { data: Array<Record<string, unknown>> };
  return data.data.map((d) => ({
    netuid: d.netuid as number,
    daysSince: d.days_since_last_event as number | undefined,
    commits: d.commits_30d as number | undefined,
    devs: d.unique_contributors_30d as number | undefined,
    repo: (d.repo_url as string) ?? "?",
  }));
}

export default function activate(api: GuiApi): void {
  const h = api.React.createElement;
  const { client } = api;

  api.registerGuiCommand("bittensor", async (args) => {
    const [sub, ...rest] = args.trim().split(/\s+/);
    if (sub === "key") {
      const key = rest.join(" ").trim();
      if (!key) return "⛏️ usage: /bittensor key <taostats-api-key>";
      localStorage.setItem(KEY_SLOT, key);
      return "⛏️ taostats key saved on this machine.";
    }
    if (sub === "list" || sub === "ls" || sub === "") {
      const key = localStorage.getItem(KEY_SLOT);
      if (!key) return "⛏️ set a taostats key first: /bittensor key <api-key>";
      if (!client.state.scope) return "⛏️ open a channel first.";
      let subnets: SubnetRow[];
      try {
        subnets = await fetchSubnets(key);
      } catch (err) {
        return `⛏️ ${err instanceof Error ? err.message : String(err)} — bad key?`;
      }
      const top = subnets
        .filter((s) => s.repo !== "?")
        .sort((a, b) => (b.commits ?? 0) - (a.commits ?? 0))
        .slice(0, 15);
      if (!top.length) return "⛏️ taostats returned no subnets.";
      const q = (n?: number) => (n === undefined ? "?" : String(n));
      const lines = top.map((s) => `SN${s.netuid} · ${q(s.daysSince)}d · ${q(s.commits)}c/30d · ${q(s.devs)}dev · ${s.repo}`);
      await client.sendChannelMessage(`${REPORT_PREFIX} — top ${top.length} by 30d commits (taostats)\n${lines.join("\n")}`);
      return "";
    }
    return [
      "⛏️ /bittensor list — post subnet dev-activity report to this channel",
      "/bittensor key <api-key> — save your taostats key (this machine only)",
      "mining runs headless: the TUI /bittensor + the standalone agent",
    ].join("\n");
  });

  api.registerMessageDecorator(
    (content) => content.startsWith(REPORT_PREFIX),
    ({ content }) => {
      const rows = parseReport(content);
      if (!rows.length) return null;
      return h(
        "div",
        { className: "bt-card" },
        h("div", { className: "bt-head" }, `⛏️ ${rows.length} subnets by dev activity`),
        ...rows.map((row) =>
          h(
            "div",
            { key: row.netuid, className: "bt-row" },
            h("span", { className: row.daysSince === 0 ? "bt-dot on" : "bt-dot" }),
            h("span", { className: "bt-sn" }, `SN${row.netuid}`),
            h("span", { className: "bt-stat" }, row.commits === undefined ? "— commits" : `${row.commits} commits/30d`),
            h("span", { className: "bt-stat" }, row.devs === undefined ? "— devs" : `${row.devs} devs`),
            h("span", { className: "bt-repo" }, row.repo.replace(/^https:\/\/(www\.)?github\.com\//, ""))
          )
        )
      );
    }
  );
}
