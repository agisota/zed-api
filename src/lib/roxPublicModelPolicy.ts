export interface RoxPublicModelSpec {
  id: "rox/explore" | "rox/standard" | "rox/max" | "rox/vision" | "rox/fast";
  target: string;
  contextLength: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: {
    tool_calling: boolean;
    reasoning: boolean;
    thinking: boolean;
    temperature: boolean;
    vision?: boolean;
  };
}

export type RoxPublicModelId = RoxPublicModelSpec["id"];
export type RoxFallbackChain = readonly string[];

const ROX_PUBLIC_MODEL_SPECS: readonly RoxPublicModelSpec[] = [
  {
    id: "rox/explore",
    target: "kmc/kimi-for-coding",
    contextLength: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 32_768,
    capabilities: { tool_calling: true, reasoning: true, thinking: true, temperature: false },
  },
  {
    id: "rox/standard",
    target: "opencode-go/kimi-k2.6",
    contextLength: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 65_536,
    capabilities: { tool_calling: true, reasoning: true, thinking: true, temperature: false },
  },
  {
    id: "rox/max",
    target: "opencode-go/kimi-k3",
    contextLength: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 131_072,
    capabilities: { tool_calling: true, reasoning: true, thinking: true, temperature: false },
  },
  {
    id: "rox/vision",
    target: "agy/gemini-3.6-flash-high",
    contextLength: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 131_072,
    capabilities: { tool_calling: true, reasoning: true, thinking: true, temperature: true, vision: true },
  },
  {
    id: "rox/fast",
    target: "agy/gemini-3.6-flash-low",
    contextLength: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: { tool_calling: true, reasoning: true, thinking: true, temperature: true },
  },
];

export function getRoxPublicModelSpecs(): readonly RoxPublicModelSpec[] {
  return ROX_PUBLIC_MODEL_SPECS;
}

/**
 * Server-authoritative fallback chains per public endpoint. The harness
 * (OMP/ROX agent) never retries across providers on its own; the gateway
 * walks these chains in order. `rox/max` intentionally has no fallback:
 * downgrading a 1M-context request to a 262k model would silently drop
 * context — fail with a capacity error instead.
 */
export const ROX_FALLBACK_CHAINS: Readonly<Record<RoxPublicModelId, RoxFallbackChain>> =
  Object.freeze({
    "rox/explore": Object.freeze([
      "kmc/kimi-for-coding",
      "opencode-go/kimi-k2.7-code",
      "opencode-go/kimi-k2.6",
    ]),
    "rox/standard": Object.freeze([
      "opencode-go/kimi-k2.6",
      "fireworks/kimi-k2p6",
      "baseten/moonshotai/Kimi-K2.6",
    ]),
    "rox/max": Object.freeze(["opencode-go/kimi-k3"]),
    "rox/vision": Object.freeze(["agy/gemini-3.6-flash-high", "agy/gemini-2.5-flash"]),
    "rox/fast": Object.freeze(["agy/gemini-3.6-flash-low", "agy/gemini-2.5-flash-lite"]),
  });

export function isRoxPublicModelId(model: unknown): model is RoxPublicModelId {
  return typeof model === "string" && Object.hasOwn(ROX_FALLBACK_CHAINS, model);
}

export function getRoxPublicModelFallbackChain(model: unknown): RoxFallbackChain | null {
  return isRoxPublicModelId(model) ? ROX_FALLBACK_CHAINS[model] : null;
}

export function isRoxPublicCatalogOnly(settings: Record<string, unknown>): boolean {
  return (
    settings.roxPublicCatalogOnly === true ||
    process.env.ROX_PUBLIC_CATALOG_ONLY?.trim().toLowerCase() === "true"
  );
}

export function isOpenRouterCatalogEntry(entry: Record<string, unknown>): boolean {
  return [entry.id, entry.root, entry.parent]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes("openrouter_"));
}

export function buildRoxPublicCatalog(timestamp: number): Array<Record<string, unknown>> {
  return ROX_PUBLIC_MODEL_SPECS.map((spec) => ({
    id: spec.id,
    object: "model",
    created: timestamp,
    owned_by: "rox",
    permission: [],
    root: spec.id,
    parent: null,
    context_length: spec.contextLength,
    max_input_tokens: spec.maxInputTokens,
    max_output_tokens: spec.maxOutputTokens,
    capabilities: { ...spec.capabilities },
  }));
}
