/**
 * Pure catalog-smoke assertions. Kept out of catalog-smoke.ts so they can be
 * unit-tested without booting the loopback catalog server.
 */
export const PUBLIC_IDS = [
  "rox/explore",
  "rox/standard",
  "rox/max",
  "rox/vision",
  "rox/fast",
] as const;

export function mentionsOpenRouter(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    return (
      lowered === "openrouter" ||
      lowered.startsWith("openrouter/") ||
      lowered.includes("/openrouter/") ||
      lowered.includes("openrouter_")
    );
  }
  if (Array.isArray(value)) return value.some(mentionsOpenRouter);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "id",
      "root",
      "parent",
      "owned_by",
      "provider",
      "providerId",
      "provider_id",
    ]) {
      if (mentionsOpenRouter(record[key])) return true;
    }
  }
  return false;
}

export function assertExactPublicIds(ids: string[]): void {
  const sorted = [...ids].sort();
  const expected = [...PUBLIC_IDS].sort();
  if (sorted.length !== expected.length || sorted.some((id, index) => id !== expected[index])) {
    throw new Error(
      `public catalog must be exactly ${expected.join(", ")}; got ${ids.join(", ") || "(empty)"}`
    );
  }
}

export function assertNormalCatalogHonesty(models: Array<Record<string, unknown>>): void {
  if (models.length === 0) {
    throw new Error("normal GET /v1/models returned an empty catalog");
  }
  const openRouterHits = models.filter(mentionsOpenRouter);
  if (openRouterHits.length > 0) {
    throw new Error(`OpenRouter leaked ${openRouterHits.length} catalog entries in normal mode`);
  }
}
