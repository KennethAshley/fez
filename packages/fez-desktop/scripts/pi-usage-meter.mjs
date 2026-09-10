/** Bridge Pi's native session totals into per-prompt ACP usage. No model calls. */
export function installPiUsageMeter(Session, Agent) {
  const initialize = Agent.prototype.initialize;
  Agent.prototype.initialize = async function (...args) {
    const result = await initialize.apply(this, args);
    return { ...result, _meta: { ...result._meta, fezUsage: 1 } };
  };
  const totals = (stats) => {
    const values = [stats.cost, stats.tokens.input, stats.tokens.output, stats.tokens.cacheRead, stats.tokens.cacheWrite];
    if (!values.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("Pi usage unavailable");
    return { costUsd: stats.cost, inputTokens: stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite, outputTokens: stats.tokens.output };
  };
  const startTurn = Session.prototype.startTurn;
  Session.prototype.startTurn = function (turn) {
    this.pendingTurn = { resolve: turn.resolve, reject: turn.reject };
    this.cancelRequested = false;
    this.fezMeterFailed = false;
    void this.proc.getSessionStats().then(stats => {
      this.fezUsageBaseline = totals(stats);
      if (this.cancelRequested) { this.pendingTurn = null; turn.resolve("cancelled"); return; }
      startTurn.call(this, turn);
    }).catch(error => { this.pendingTurn = null; turn.reject(error); });
  };
  const handlePiEvent = Session.prototype.handlePiEvent;
  Session.prototype.handlePiEvent = function (event) {
    if (this.pendingTurn && ["message_end", "compaction_end", "auto_compaction_end", "agent_settled"].includes(event.type)) {
      const complete = event.type === "agent_settled";
      // Join the adapter's existing drain: the final total precedes prompt completion.
      this.lastEmit = this.lastEmit.then(async () => {
        const now = totals(await this.proc.getSessionStats());
        const usage = Object.fromEntries(Object.entries(now).map(([k, n]) => [k, n - this.fezUsageBaseline[k]]));
        if (Object.values(usage).some(n => n < 0)) throw new Error("Pi usage regressed");
        await this.conn.sessionUpdate({ sessionId: this.sessionId, update: {
          sessionUpdate: "session_info_update", _meta: { fezUsage: { ...usage, complete: complete && !this.fezMeterFailed } },
        } });
      }).catch(async () => {
        this.fezMeterFailed = true;
        await this.conn.sessionUpdate({ sessionId: this.sessionId, update: {
          sessionUpdate: "session_info_update", _meta: { fezUsage: { error: true } },
        } }).catch(() => {});
        void this.cancel().catch(() => {});
      });
    }
    return handlePiEvent.call(this, event);
  };
}

/** Fail loudly if the pinned adapter's entry point changes. */
export function patchPiUsageMeter(source) {
  const anchor = "var agent = new AgentSideConnection((conn) => new PiAcpAgent(conn), stream);";
  if (source.split(anchor).length !== 2 || source.includes("function installPiUsageMeter")) throw new Error("Unexpected pi-acp source for usage patch");
  return source.replace(anchor, `(${installPiUsageMeter.toString()})(PiAcpSession, PiAcpAgent);\n${anchor}`);
}
