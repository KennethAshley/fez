export interface ExtensionModelProvider {
  id: string;
  label: string;
  listModels(): Promise<Array<{ id: string; label: string; status: "ready" | "offline" | "busy"; detail?: string }>>;
  prepare(persona: string, model: string): Promise<void>;
}

const providers = new Map<string, ExtensionModelProvider>();

export function registerModelProvider(source: string, provider: ExtensionModelProvider): void {
  const slug = source.replace(/^@/, "").replace(/\//g, "-");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
      !provider || typeof provider.id !== "string" ||
      !provider.id.startsWith(`ext-${slug}-`) ||
      !/^ext-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider.id) ||
      provider.id.length > 96 ||
      typeof provider.label !== "string" || !provider.label.trim() ||
      typeof provider.listModels !== "function" || typeof provider.prepare !== "function") {
    throw new Error(`Invalid model provider for extension ${source}`);
  }
  if (providers.has(provider.id)) throw new Error(`Model provider ${provider.id} is already registered`);
  providers.set(provider.id, provider);
}

export function snapshotModelProviders(): () => void {
  const snapshot = new Map(providers);
  return () => { providers.clear(); for (const [id, provider] of snapshot) providers.set(id, provider); };
}

export async function listModelProviders(): Promise<Array<{ provider: ExtensionModelProvider; models: Awaited<ReturnType<ExtensionModelProvider["listModels"]>>; error?: string }>> {
  return Promise.all([...providers.values()].map(async (provider) => {
    try {
      const models = await provider.listModels();
      if (!Array.isArray(models) || !models.every(model => model &&
          typeof model.id === "string" && /^[^\r\n\x00-\x1f]{1,256}$/.test(model.id) &&
          typeof model.label === "string" && model.label.trim() &&
          ["ready", "offline", "busy"].includes(model.status) &&
          (model.detail === undefined || typeof model.detail === "string")) ||
          new Set(models.map(model => model.id)).size !== models.length) throw new Error("Invalid model list");
      return { provider, models };
    }
    catch (error) { return { provider, models: [], error: String(error) }; }
  }));
}

export async function prepareAgentModel(selection: { harness: string; provider: string; modelProfile?: string; model: string }, persona: string): Promise<void> {
  if (!selection.modelProfile) return;
  if (selection.harness !== "pi" || selection.provider !== selection.modelProfile) throw new Error("Select the model again before saving.");
  const provider = providers.get(selection.modelProfile);
  if (!provider) throw new Error(`Model provider ${selection.modelProfile} is unavailable. Restore its extension before saving.`);
  if (!/^[^\r\n\x00-\x1f]{1,256}$/.test(selection.model)) throw new Error("Select a model before saving.");
  await provider.prepare(persona, selection.model);
}
