import { validateInputResponse, type InputAnswers, type InputForm, type InputResponse } from "../../packages/fez-client/dist/agent-input.js";

/** Uses the TUI's existing editor; no second stdin reader or raw-mode owner. */
export class TerminalInputs {
  private requests = new Map<string, { number: number; name: string; form: InputForm; submit: (r: InputResponse) => Promise<void> }>();
  private next = 1;
  private active?: { id: string; index: number; answers: InputAnswers };
  constructor(private print: (text: string) => void) {}

  add(id: string, name: string, form: InputForm, submit: (r: InputResponse) => Promise<void>): void {
    if (this.requests.has(id)) return;
    const number = this.next++;
    this.requests.set(id, { number, name, form, submit });
    this.print(`@${name} has questions: ${form.message}\nType /answer ${number} to respond privately, or /questions to list requests.`);
  }
  remove(id: string): void {
    if (this.active?.id === id) { this.active = undefined; this.print("Question closed. Back to chat."); }
    this.requests.delete(id);
  }
  private show(): void {
    if (!this.active) return;
    const request = this.requests.get(this.active.id)!;
    const field = request.form.fields[this.active.index];
    if (!field) {
      const summary = request.form.fields.map(f => `${f.title}: ${String(this.active!.answers[f.id] ?? "skipped")}`).join("\n");
      this.print(`${summary}\nType /submit to send these answers, /answer ${request.number} to start again, or /cancel.`);
      return;
    }
    this.print(`${this.active.index + 1}/${request.form.fields.length} · ${field.title}\n${field.description ?? ""}\n` +
      (field.options?.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n") ?? "") +
      `\n${field.type === "array" ? "Choose numbers separated by commas." : field.options ? "Choose a number or option label." : field.type === "boolean" ? "Type yes or no." : "Type your answer."} /skip skips this field; /cancel cancels the request.`);
  }
  async handle(text: string): Promise<boolean> {
    if (text === "/questions") {
      this.print([...this.requests.values()].map(r => `/answer ${r.number} · @${r.name}: ${r.form.message}`).join("\n") || "No questions waiting.");
      return true;
    }
    if (/^\/answer(?:\s|$)/.test(text)) {
      const number = Number(text.split(/\s+/)[1]);
      const found = [...this.requests].find(([, r]) => r.number === number);
      if (!found) this.print("Choose a request from /questions.");
      else { this.active = { id: found[0], index: 0, answers: {} }; this.show(); }
      return true;
    }
    if (!this.active) return false;
    const active = this.active;
    const request = this.requests.get(active.id)!;
    try {
      if (text === "/cancel" || text === "/submit") {
        const response = text === "/cancel" ? { action: "cancel" as const }
          : validateInputResponse(request.form, { action: "accept", content: active.answers });
        if (text === "/submit" && active.index < request.form.fields.length) throw new Error("Answer the remaining questions first.");
        await request.submit(response);
        if (this.active === active) this.active = undefined;
        this.print("Response sent. Back to chat.");
        return true;
      }
      const field = request.form.fields[active.index];
      if (!field) { this.show(); return true; }
      if (text === "/quit" || text === "/q") return false;
      let value: InputAnswers[string] | undefined;
      if (text !== "/skip") {
        const pick = (s: string) => field.options?.[Number(s.trim()) - 1]?.value ?? field.options?.find(o => o.label === s.trim() || o.value === s.trim())?.value ?? s.trim();
        value = field.type === "array" ? text.split(",").map(pick) : field.options ? pick(text)
          : field.type === "number" || field.type === "integer" ? Number(text)
            : field.type === "boolean" ? /^(yes|true)$/i.test(text) ? true : /^(no|false)$/i.test(text) ? false : text : text;
      }
      const answer = validateInputResponse({ message: request.form.message, fields: [field] }, { action: "accept", content: value === undefined ? {} : { [field.id]: value } });
      if (answer.action === "accept") Object.assign(active.answers, answer.content);
      active.index++;
      this.show();
    } catch (error) { this.print(error instanceof Error ? error.message : String(error)); }
    return true;
  }
}
