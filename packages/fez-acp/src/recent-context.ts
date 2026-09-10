/** Ten messages in each of 100 recently used conversations; evicted history is dropped. */
export class RecentContexts {
  private readonly scopes = new Map<string, { id: string; text: string }[]>();

  add(scope: string, id: string, message: string): void {
    const messages = this.scopes.get(scope) ?? [];
    this.scopes.delete(scope);
    this.scopes.set(scope, [...messages.slice(-9), { id, text: message }]);
    if (this.scopes.size > 100) this.scopes.delete(this.scopes.keys().next().value!);
  }

  get(scope: string, trigger: string): readonly string[] {
    const messages = this.scopes.get(scope);
    if (!messages) return [trigger]; // A queued/retrying turn must retain its original request.
    this.scopes.delete(scope);
    this.scopes.set(scope, messages);
    return messages.map((message) => message.text);
  }

  remove(scope: string, id: string): void {
    const messages = this.scopes.get(scope)?.filter((message) => message.id !== id);
    if (messages?.length) this.scopes.set(scope, messages);
    else this.scopes.delete(scope);
  }
}
