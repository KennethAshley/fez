import { describe, expect, it } from "vitest";
import { FezClient, K, type Wire, type WireEvent, type WireFilter, type WireQueryResult } from "../../fez-client/src/index.js";

const message = (id: string, channel = "a", ts = 100): WireEvent => ({
  id, kind: K.MESSAGE, pubkey: "owner", created_at: ts, tags: [["h", channel]], content: id, sig: "",
});
function setup(query: (filters: WireFilter[]) => Promise<WireEvent[]>, queryWithStatus?: Wire["queryWithStatus"]) {
  const wire: Wire = { pubkey: "reader", query, queryWithStatus,
    subscribe: () => () => {}, publish: async () => { throw Error("unexpected write"); },
    encrypt: (_p, text) => text, decrypt: (_p, text) => text,
    sendDm: async () => "", unwrapDm: () => undefined,
  };
  const client = new FezClient(wire);
  client.state.workspace.members.set("owner", "owner");
  return client;
}
const failed = (events: WireEvent[] = []): WireQueryResult => ({ events, failures: [{ url: "ws://offline", reason: "connection closed" }] });

describe("channel history loading", () => {
  it("retries a sparse question thread without skipping ordinary channel history", async () => {
    let offline = true;
    const boundaries: (number | undefined)[] = [];
    const client = setup(async () => [], async filters => {
      const filter = filters[0];
      if (filter.until !== undefined) {
        boundaries.push(filter.until);
        return { events: [message("middle", "a", 75)], failures: [] };
      }
      if (filter.ids) return offline ? failed([message("thread-root", "a", 10)])
        : { events: [message("thread-root", "a", 10), message("thread-reply", "a", 20)], failures: [] };
      return { events: filter.kinds?.includes(K.MESSAGE) ? [message("recent", "a", 100)] : [], failures: [] };
    });
    await client.loadChannelHistory("a", "thread-root");
    expect(client.historyState("a").status).toBe("error");
    offline = false;
    await client.loadChannelHistory("a", "thread-root");
    expect(client.historyState("a").status).toBe("ready");
    await client.loadOlderPage("a");
    expect(boundaries).toEqual([100]);
    expect(client.messages("a").map(m => m.id)).toEqual(["thread-root", "thread-reply", "middle", "recent"]);
  });

  it("retains a failed initial load when a sparse thread cannot establish a paging cursor", async () => {
    let offline = true;
    const boundaries: (number | undefined)[] = [];
    const client = setup(async () => [], async filters => {
      const filter = filters[0];
      if (filter.until !== undefined) {
        boundaries.push(filter.until);
        return { events: [], failures: [] };
      }
      if (filter.ids) return { events: [message("ancient-thread", "a", 10)], failures: [] };
      const events = filter.kinds?.includes(K.MESSAGE) ? [message("recent", "a", 1000)] : [];
      return offline ? failed(events) : { events, failures: [] };
    });
    await client.loadChannelHistory("a", "ancient-thread");
    await client.loadOlderPage("a");
    expect(boundaries).toEqual([]);
    expect(client.historyState("a")).toMatchObject({ status: "error", operation: "recent" });
    expect(client.channelExhausted("a")).toBe(false);
    offline = false;
    await client.loadChannelHistory("a", "ancient-thread");
    await client.loadOlderPage("a");
    expect(boundaries).toEqual([1000]);
  });

  it("keeps successful messages when another history query fails", async () => {
    const client = setup(async filters => {
      if (filters[0].kinds?.includes(K.REACTION)) throw Error("offline");
      return filters[0].kinds?.includes(K.MESSAGE) ? [message("available")] : [];
    });
    await expect(client.loadChannelHistory("a")).resolves.toBeUndefined();
    expect(client.messages("a").map(m => m.content)).toEqual(["available"]);
    expect(client.historyState("a")).toMatchObject({ status: "error", partial: true });
  });

  it("distinguishes an empty successful query from failure and recovers on retry", async () => {
    let offline = true;
    const client = setup(async () => [], async () => offline ? failed() : { events: [], failures: [] });
    const pending = client.loadChannelHistory("a");
    expect(client.historyState("a").status).toBe("loading");
    await pending;
    expect(client.historyState("a").status).toBe("error");
    offline = false;
    await client.loadChannelHistory("a");
    expect(client.historyState("a").status).toBe("ready");
    expect(client.messages("a")).toEqual([]);
  });

  it("keeps cached and partial messages through an unsuccessful retry", async () => {
    let retry = false;
    const client = setup(async () => [], async filters => {
      const events = filters[0].kinds?.includes(K.MESSAGE) ? [message(retry ? "partial" : "cached")] : [];
      return retry ? failed(events) : { events, failures: [] };
    });
    await client.loadChannelHistory("a");
    retry = true;
    await client.loadChannelHistory("a");
    expect(client.messages("a").map(m => m.id).sort()).toEqual(["cached", "partial"]);
    expect(client.historyState("a")).toMatchObject({ status: "error", partial: true });
  });

  it("keeps errors scoped to their channel and ignores an older request's status", async () => {
    const pending: ((result: WireQueryResult) => void)[] = [];
    let delay = true;
    const client = setup(async () => [], async () => delay ? new Promise(resolve => pending.push(resolve)) : { events: [], failures: [] });
    const old = client.loadChannelHistory("a");
    delay = false;
    await client.loadChannelHistory("a");
    await client.loadChannelHistory("b");
    pending.forEach(resolve => resolve(failed()));
    await old;
    expect(client.historyState("a").status).toBe("ready");
    expect(client.historyState("b").status).toBe("ready");
  });

  it("does not mark failed older-history paging as exhausted", async () => {
    let paging = false;
    const client = setup(async () => [], async filters => paging ? failed() : {
      events: filters[0].kinds?.includes(K.MESSAGE) ? [message("newest")] : [], failures: [],
    });
    await client.loadChannelHistory("a");
    paging = true;
    await client.loadOlderPage("a");
    expect(client.channelExhausted("a")).toBe(false);
    expect(client.historyState("a")).toMatchObject({ status: "error", operation: "older" });
    expect(client.messages("a")).toHaveLength(1);
  });

  it("retries the same older-history window after retaining a partial page", async () => {
    const boundaries: (number | undefined)[] = [];
    const client = setup(async () => [], async filters => {
      const filter = filters[0];
      if (filter.until !== undefined) {
        boundaries.push(filter.until);
        return boundaries.length === 1 ? failed([message("oldest", "a", 50)]) : {
          events: [message("oldest", "a", 50), message("missing", "a", 75)], failures: [],
        };
      }
      return { events: filter.kinds?.includes(K.MESSAGE) ? [message("newest")] : [], failures: [] };
    });
    await client.loadChannelHistory("a");
    await client.loadOlderPage("a");
    expect(client.messages("a").map(m => m.id)).toEqual(["oldest", "newest"]);
    await client.loadOlderPage("a");
    expect(boundaries).toEqual([100, 100]);
    expect(client.messages("a").map(m => m.id)).toEqual(["oldest", "missing", "newest"]);
    expect(client.historyState("a").status).toBe("ready");
  });

  it("advances through complete pages without skipping over a cached partial outlier", async () => {
    const boundaries: (number | undefined)[] = [];
    const client = setup(async () => [], async filters => {
      const filter = filters[0];
      if (filter.until !== undefined) {
        boundaries.push(filter.until);
        if (boundaries.length === 1) return failed([message("outlier", "a", 100)]);
        if (boundaries.length === 2) return {
          events: Array.from({ length: 51 }, (_, i) => message(`page-${i}`, "a", 1000 - i)), failures: [],
        };
        return { events: [], failures: [] };
      }
      return { events: filter.kinds?.includes(K.MESSAGE) ? [message("newest", "a", 1000)] : [], failures: [] };
    });
    await client.loadChannelHistory("a");
    await client.loadOlderPage("a");
    await client.loadOlderPage("a");
    expect(client.channelExhausted("a")).toBe(false);
    await client.loadOlderPage("a");
    expect(boundaries).toEqual([1000, 1000, 950]);
  });

  it("reports a non-advancing timestamp page instead of claiming completion", async () => {
    const client = setup(async () => [], async filters => ({
      events: filters[0].until !== undefined
        ? Array.from({ length: 51 }, (_, i) => message(`burst-${i}`, "a", 1000))
        : filters[0].kinds?.includes(K.MESSAGE) ? [message("newest", "a", 1000)] : [],
      failures: [],
    }));
    await client.loadChannelHistory("a");
    await client.loadOlderPage("a");
    expect(client.historyState("a")).toMatchObject({ status: "error", operation: "older", partial: true });
    expect(client.historyState("a").error).toContain("same timestamp");
    expect(client.channelExhausted("a")).toBe(false);
    expect(client.messages("a")).toHaveLength(52);
  });
});
