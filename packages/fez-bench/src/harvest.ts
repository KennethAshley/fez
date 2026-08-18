/**
 * The harvest — live misroutes become bench-case PROPOSALS. A misroute
 * leaves a signed trace in channel history: fez's routing forward
 * ("@agent (from Ken) task…") followed by that agent immediately
 * punting (handing off to a sibling, or declining). Each trace becomes
 * a candidate case with expect = where the punt pointed; the owner
 * approves or denies via the ledger — the machine collects, the human
 * decides what counts as ground truth.
 */

const KIND_CHANNEL_MESSAGE = 47103;
const KIND_AGENT_METADATA = 47000;
const ROUTE_RE = /^@([\w-]+) \(from [^)]+\) (.+)$/s;
const PUNT_RE = /not my (area|thing|lane)|better suited|more of an? .{1,30} (thing|task|job)|can'?t help with|outside my/i;

interface WireEvent {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}

function query(relayUrl: string, filter: object): Promise<WireEvent[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const events: WireEvent[] = [];
    const timer = setTimeout(() => {
      ws.close();
      resolve(events);
    }, 8000);
    ws.onopen = () => ws.send(JSON.stringify(["REQ", "harvest", filter]));
    ws.onmessage = (msg) => {
      const frame = JSON.parse(String(msg.data)) as [string, ...unknown[]];
      if (frame[0] === "EVENT") events.push(frame[2] as WireEvent);
      if (frame[0] === "EOSE") {
        clearTimeout(timer);
        ws.close();
        resolve(events);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`relay unreachable: ${relayUrl}`));
    };
  });
}

export interface HarvestCandidate {
  q: string;
  routedTo: string;
  puntedTo: string;
  ts: number;
}

export async function harvest(relayUrl: string, sinceDays = 7): Promise<HarvestCandidate[]> {
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  const [messages, announcements] = await Promise.all([
    query(relayUrl, { kinds: [KIND_CHANNEL_MESSAGE], since, limit: 2000 }),
    query(relayUrl, { kinds: [KIND_AGENT_METADATA], limit: 200 }),
  ]);
  const agentNames = new Set<string>();
  const nameByPk = new Map<string, string>();
  for (const event of announcements) {
    try {
      const name = (JSON.parse(event.content) as { name?: string }).name;
      if (name) {
        agentNames.add(name.toLowerCase());
        nameByPk.set(event.pubkey, name);
      }
    } catch { /* ignore */ }
  }

  messages.sort((a, b) => a.created_at - b.created_at);
  const candidates: HarvestCandidate[] = [];
  for (const message of messages) {
    const route = ROUTE_RE.exec(message.content.trim());
    if (!route) continue;
    const routedTo = route[1].toLowerCase();
    const task = route[2].trim();
    if (!agentNames.has(routedTo)) continue;
    // the routed agent's next message in the same thread within 15 min
    const threadRoot = message.tags.find((t) => t[0] === "e")?.[1] ?? message.id;
    const reply = messages.find(
      (m) =>
        nameByPk.get(m.pubkey)?.toLowerCase() === routedTo &&
        m.created_at > message.created_at &&
        m.created_at < message.created_at + 900 &&
        (m.tags.some((t) => t[0] === "e" && (t[1] === threadRoot || t[1] === message.id)) || true)
    );
    if (!reply) continue;
    const firstBit = reply.content.slice(0, 300);
    const mentioned = [...firstBit.matchAll(/@([\w-]+)/g)]
      .map((m) => m[1].toLowerCase())
      .find((n) => agentNames.has(n) && n !== routedTo);
    const punted = PUNT_RE.test(firstBit) || (mentioned !== undefined && firstBit.length < 200);
    if (punted && mentioned) {
      candidates.push({ q: task, routedTo, puntedTo: mentioned, ts: message.created_at * 1000 });
    }
  }
  return candidates;
}
