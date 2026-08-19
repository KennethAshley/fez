/**
 * The query block's little language — pure, eval-pinned.
 *
 * A query is a SENTENCE, not a syntax: "unfinished tasks, by page",
 * "approvals waiting on me", "spend per agent, last 7 days". Word order
 * is flexible and synonyms are generous, because the two authors are a
 * person typing quickly and an agent writing markdown — neither should
 * have to learn a grammar.
 *
 * It is deliberately NOT natural-language understanding. It is a small
 * vocabulary matched deterministically, and anything it does not
 * recognize is REPORTED rather than ignored: a query that quietly
 * returns the wrong set is worse than one that says what it didn't
 * understand. Same reasoning as route-logic and vote-logic — this is
 * pinned by tests because a silent change of meaning is a bug you only
 * notice when a dashboard has been lying for a week.
 */

export type QuerySource = "tasks" | "approvals" | "pages" | "comments" | "runs" | "spend" | "mentions";
export type QueryView = "list" | "table" | "board";

export interface Query {
  source: QuerySource;
  /** tasks: true = only unfinished, false = only done, undefined = all. */
  open?: boolean;
  /** Restrict to an agent/person, without the @. */
  who?: string;
  /** "waiting on me" — items blocked on the reader. */
  mine?: boolean;
  /** Look back this many days; undefined = no time bound. */
  sinceDays?: number;
  /** Group by this dimension ("page", "agent", "channel", "status"). */
  groupBy?: string;
  view: QueryView;
  limit: number;
  /** Words we did not understand — surfaced in the render, never silent. */
  unknown: string[];
}

const SOURCES: [QuerySource, string[]][] = [
  ["tasks", ["task", "tasks", "todo", "todos", "checkbox", "checkboxes"]],
  ["approvals", ["approval", "approvals", "decision", "decisions"]],
  ["pages", ["page", "pages", "doc", "docs", "document", "documents"]],
  ["comments", ["comment", "comments", "note", "notes"]],
  ["runs", ["run", "runs", "workflow", "workflows"]],
  ["spend", ["spend", "cost", "costs", "spending", "budget"]],
  ["mentions", ["mention", "mentions"]],
];

const OPEN_WORDS = ["unfinished", "open", "incomplete", "outstanding", "undone", "pending", "unanswered", "waiting"];
const DONE_WORDS = ["done", "finished", "complete", "completed", "closed", "answered"];
const VIEWS: [QueryView, string[]][] = [
  ["board", ["board", "kanban", "columns"]],
  ["table", ["table", "grid"]],
  ["list", ["list"]],
];
const GROUP_WORDS = ["page", "agent", "channel", "status", "author", "day"];
/** Words that are grammar, not meaning — never reported as unknown. */
const FILLER = new Set([
  "a", "an", "the", "as", "by", "per", "in", "of", "for", "and", "on", "at", "to",
  "show", "list", "all", "me", "my", "last", "this", "these", "that", "with", "from",
  "grouped", "group", "sorted", "sort", "everything", "still", "are", "is", "it",
]);

const PERIODS: [RegExp, number][] = [
  [/\btoday\b/, 1],
  [/\byesterday\b/, 2],
  [/\bthis week\b/, 7],
  [/\blast week\b/, 14],
  [/\bthis month\b/, 30],
];

export function parseQuery(input: string): Query {
  const text = (input ?? "").trim().toLowerCase();
  const query: Query = { source: "tasks", view: "list", limit: 50, unknown: [] };
  if (!text) return { ...query, unknown: ["(empty query)"] };

  // multi-word phrases first, so their words aren't reported as unknown
  const consumed = new Set<string>();
  const eat = (phrase: string) => {
    for (const word of phrase.split(/\s+/)) consumed.add(word);
  };

  if (/\bwaiting on me\b|\bfor me\b|\bmine\b|\bneeds me\b/.test(text)) {
    query.mine = true;
    eat("waiting on me for me mine needs me");
  }
  for (const [pattern, days] of PERIODS) {
    const match = pattern.exec(text);
    if (match) {
      query.sinceDays = days;
      eat(match[0]);
    }
  }
  const explicitDays = /\blast (\d+) days?\b/.exec(text);
  if (explicitDays) {
    query.sinceDays = Math.max(1, Math.min(Number(explicitDays[1]), 365));
    eat(explicitDays[0]);
  }
  const who = /@([\w-]+)/.exec(text);
  if (who) {
    query.who = who[1];
    eat(who[0]);
  }
  const groupBy = /\b(?:by|per|grouped by) ([a-z]+)\b/.exec(text);
  if (groupBy && GROUP_WORDS.includes(groupBy[1])) {
    query.groupBy = groupBy[1];
    eat(groupBy[0]);
  }
  const limit = /\b(?:top|first|limit) (\d+)\b/.exec(text);
  if (limit) {
    query.limit = Math.max(1, Math.min(Number(limit[1]), 500));
    eat(limit[0]);
  }

  let sourceFound = false;
  for (const word of text.split(/[\s,.]+/).filter(Boolean)) {
    if (consumed.has(word) || FILLER.has(word)) continue;
    const source = SOURCES.find(([, words]) => words.includes(word));
    if (source && !sourceFound) {
      query.source = source[0];
      sourceFound = true;
      continue;
    }
    const view = VIEWS.find(([, words]) => words.includes(word));
    if (view) {
      query.view = view[0];
      continue;
    }
    if (OPEN_WORDS.includes(word)) {
      query.open = true;
      continue;
    }
    if (DONE_WORDS.includes(word)) {
      query.open = false;
      continue;
    }
    if (source) continue; // a second source word — harmless
    query.unknown.push(word);
  }

  // "approvals" and "unanswered mentions" are open-by-default: nobody
  // writes a dashboard of decisions they already made.
  if (query.open === undefined && (query.source === "approvals" || query.source === "tasks")) {
    query.open = true;
  }
  // Grouping into columns only means something as a board.
  if (query.groupBy === "status" && query.view === "list") query.view = "board";
  return query;
}

/** One line under the results saying what was actually asked. */
export function describeQuery(query: Query): string {
  // Reads as a phrase, not a list: the qualifier binds to the noun
  // ("open tasks"), and only separate clauses get a divider.
  const noun = [query.open === true ? "open" : query.open === false ? "done" : "", query.source]
    .filter(Boolean)
    .join(" ");
  const clauses = [
    query.who ? `for @${query.who}` : "",
    query.mine ? "waiting on you" : "",
    query.sinceDays ? `last ${query.sinceDays}d` : "",
    query.groupBy ? `by ${query.groupBy}` : "",
  ].filter(Boolean);
  return [noun, ...clauses].join(" · ");
}
