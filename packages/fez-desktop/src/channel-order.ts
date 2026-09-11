import { useMemo, useReducer } from "react";

export function orderChannels<T extends { id: string }>(channels: Iterable<T>, saved: readonly string[]): T[] {
  const ranks = new Map(saved.map((id, index) => [id, index]));
  return [...channels].sort((a, b) =>
    (ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function moveChannel(order: string[], id: string, target: string, after: boolean): string[] {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const next = order.filter(value => value !== id);
  next.splice(next.indexOf(target) + Number(after), 0, id);
  return next;
}

// A sidebar preference belongs to this identity in this workspace on this device.
// Read on a scope change as well as mount; never copy one workspace's order into another.
export function useChannelOrder(pubkey: string, relay: string): [string[], (ids: string[]) => void] {
  const key = `fez-channel-order:${JSON.stringify([pubkey, relay])}`;
  const [revision, refresh] = useReducer(n => n + 1, 0);
  const saved = useMemo(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
    } catch { return []; }
  }, [key, revision]);
  return [saved, ids => {
    // A failed write must leave the displayed order alone so the caller can offer a retry.
    localStorage.setItem(key, JSON.stringify(ids));
    refresh();
  }];
}
