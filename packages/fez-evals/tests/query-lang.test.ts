import { describe, expect, it } from "vitest";
import { parseQuery, describeQuery } from "../../fez-client/dist/query-lang.js";

/**
 * A query block renders a dashboard people trust. If parsing silently
 * changes meaning, the dashboard lies and nobody notices — so the
 * vocabulary is pinned here, the same way routing and vote-logic are.
 */
describe("query language", () => {
  it("reads the sentences people actually write", () => {
    expect(parseQuery("unfinished tasks, by page")).toMatchObject({
      source: "tasks",
      open: true,
      groupBy: "page",
      view: "list",
    });
    expect(parseQuery("approvals waiting on me")).toMatchObject({ source: "approvals", mine: true, open: true });
    expect(parseQuery("spend per agent, last 7 days")).toMatchObject({
      source: "spend",
      groupBy: "agent",
      sinceDays: 7,
    });
    expect(parseQuery("tasks for @deployer, as a board")).toMatchObject({
      source: "tasks",
      who: "deployer",
      view: "board",
    });
  });

  it("accepts synonyms and free word order", () => {
    for (const phrasing of [
      "open tasks by page",
      "tasks, open, grouped by page",
      "show all outstanding todos by page",
    ]) {
      expect(parseQuery(phrasing), phrasing).toMatchObject({ source: "tasks", open: true, groupBy: "page" });
    }
  });

  it("understands done as the opposite of open", () => {
    expect(parseQuery("finished tasks this week")).toMatchObject({ source: "tasks", open: false, sinceDays: 7 });
    expect(parseQuery("completed tasks")).toMatchObject({ open: false });
  });

  it("defaults tasks and approvals to OPEN — nobody dashboards settled work", () => {
    expect(parseQuery("tasks").open).toBe(true);
    expect(parseQuery("approvals").open).toBe(true);
    // …but other sources have no such default
    expect(parseQuery("pages").open).toBeUndefined();
  });

  it("reports what it did not understand instead of guessing", () => {
    const query = parseQuery("tasks assigned to whoever wrote them");
    expect(query.source).toBe("tasks");
    expect(query.unknown).toContain("assigned");
    expect(query.unknown).toContain("whoever");
    // an empty query is a mistake worth naming, not an empty list
    expect(parseQuery("").unknown.length).toBeGreaterThan(0);
  });

  it("never counts grammar words as unknown", () => {
    expect(parseQuery("show me all the open tasks by page").unknown).toEqual([]);
    expect(parseQuery("spend per agent this week").unknown).toEqual([]);
  });

  it("bounds time and limits rather than trusting the text", () => {
    expect(parseQuery("tasks last 9999 days").sinceDays).toBe(365);
    expect(parseQuery("tasks top 9999").limit).toBe(500);
    expect(parseQuery("tasks top 0").limit).toBe(1);
    expect(parseQuery("tasks").limit).toBe(50);
  });

  it("promotes status grouping to a board — columns are the point", () => {
    expect(parseQuery("tasks by status").view).toBe("board");
    // an explicit view still wins
    expect(parseQuery("tasks by status as a table").view).toBe("table");
  });

  it("describes back what it understood", () => {
    expect(describeQuery(parseQuery("unfinished tasks by page"))).toBe("open tasks · by page");
    expect(describeQuery(parseQuery("spend per agent last 7 days"))).toBe("spend · last 7d · by agent");
    expect(describeQuery(parseQuery("approvals waiting on me"))).toBe("open approvals · waiting on you");
  });
});
