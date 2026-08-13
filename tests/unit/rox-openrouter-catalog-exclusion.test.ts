import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rox-openrouter-"));
const ORIGINAL_ROX_PUBLIC_CATALOG_ONLY = process.env.ROX_PUBLIC_CATALOG_ONLY;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "rox-openrouter-exclusion-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

// The catalog qualifies every OpenRouter model as `openrouter/<vendor>/<model>` and
// stamps `owned_by: "openrouter"`, so the canonical id never contains `openrouter_`.
const OPENROUTER_UPSTREAM_ID = "openai/gpt-4o-exclusion-regression";
const CANONICAL_OPENROUTER_ID = `openrouter/${OPENROUTER_UPSTREAM_ID}`;

interface CatalogModel extends Record<string, unknown> {
  id: string;
}

interface ModelsCatalogResponseBody {
  data: CatalogModel[];
}

/**
 * getOpenRouterCatalog() serves a within-TTL disk cache before it ever reaches the
 * network, so seeding the cache keeps this regression deterministic and offline.
 */
function seedOpenRouterCatalogCache(): void {
  const cacheDir = path.join(TEST_DATA_DIR, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "openrouter-catalog.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: [
        {
          id: OPENROUTER_UPSTREAM_ID,
          name: "GPT-4o Exclusion Regression",
          context_length: 128_000,
          pricing: { prompt: "0.0000025", completion: "0.00001" },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    }),
    "utf8"
  );
}

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  seedOpenRouterCatalogCache();
  await providersDb.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: "openrouter-exclusion-regression",
    apiKey: "sk-or-test",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

async function fetchCatalog(apiKey?: string): Promise<ModelsCatalogResponseBody> {
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request(
      "http://localhost/api/v1/models",
      apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined
    )
  );
  assert.equal(response.status, 200);
  return (await response.json()) as ModelsCatalogResponseBody;
}

/**
 * Deliberately independent of `isOpenRouterCatalogEntry`: if the oracle reused the
 * production predicate, a predicate bug would silently make these assertions vacuous
 * (exactly the gap that let canonical `openrouter/...` entries ship). This casts a
 * strictly wider net over the identity/ownership fields — the requirement is that no
 * catalog entry advertises OpenRouter at all.
 */
function openRouterEntries(body: ModelsCatalogResponseBody): CatalogModel[] {
  return body.data.filter((model) =>
    [model.id, model.root, model.parent, model.owned_by, model.provider].some(
      (value) => typeof value === "string" && value.toLowerCase().includes("openrouter")
    )
  );
}

test.beforeEach(async () => {
  delete process.env.ROX_PUBLIC_CATALOG_ONLY;
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_ROX_PUBLIC_CATALOG_ONLY === undefined) {
    delete process.env.ROX_PUBLIC_CATALOG_ONLY;
  } else {
    process.env.ROX_PUBLIC_CATALOG_ONLY = ORIGINAL_ROX_PUBLIC_CATALOG_ONLY;
  }
});

test("catalog fixture really emits a canonical OpenRouter entry before policy filtering", async () => {
  const { getOpenRouterCatalog } = await import("../../src/lib/catalog/openrouterCatalog.ts");
  const catalog = await getOpenRouterCatalog();

  assert.equal(catalog.fromCache, true, "fixture must be served from disk, never the network");
  assert.deepEqual(
    catalog.data.map((entry) => entry.id),
    [OPENROUTER_UPSTREAM_ID]
  );
});

test("normal-mode /v1/models excludes canonical OpenRouter entries", async () => {
  const body = await fetchCatalog();

  assert.ok(body.data.length > 0, "catalog must not be empty, otherwise the assertion is vacuous");
  assert.deepEqual(
    openRouterEntries(body).map((model) => model.id),
    []
  );
  assert.equal(
    body.data.some((model) => model.id === CANONICAL_OPENROUTER_ID),
    false
  );
});

test("a master key with no DB metadata row still gets an OpenRouter-free catalog", async () => {
  // #6406: a key without an api_keys row is an env-var master key, so the catalog
  // deliberately skips per-model scoping for it. That bypass must not bypass policy.
  const body = await fetchCatalog("omniroute-env-master-key-without-db-row");

  assert.ok(body.data.length > 0, "master keys must still see the catalog");
  assert.deepEqual(
    openRouterEntries(body).map((model) => model.id),
    []
  );
});

test("a DB-backed key that allows an OpenRouter model cannot reintroduce it", async () => {
  const key = await apiKeysDb.createApiKey("rox-openrouter-scoped", "rox-openrouter-machine");
  await apiKeysDb.updateApiKeyPermissions(key.id, {
    allowedModels: [CANONICAL_OPENROUTER_ID, OPENROUTER_UPSTREAM_ID],
  });

  // Guards against a vacuous pass: the key really does grant the excluded model, so an
  // empty result proves catalog policy removed it rather than the permission check.
  assert.equal(await apiKeysDb.isModelAllowedForKey(key.key, CANONICAL_OPENROUTER_ID), true);

  const body = await fetchCatalog(key.key);

  assert.deepEqual(
    openRouterEntries(body).map((model) => model.id),
    []
  );
});

test("a DB-backed wildcard key keeps its other models but never OpenRouter", async () => {
  const key = await apiKeysDb.createApiKey("rox-openrouter-wildcard", "rox-openrouter-machine");
  // `tllm/*` spans both OpenRouter-backed (`tllm/openrouter_*`) and unrelated models,
  // so a correct filter must drop only the former and keep the rest.
  await apiKeysDb.updateApiKeyPermissions(key.id, {
    allowedModels: ["openrouter/*", "tllm/*"],
  });

  const body = await fetchCatalog(key.key);
  const ids = body.data.map((model) => model.id);

  assert.ok(
    ids.some((id) => id.startsWith("tllm/")),
    "the key's unrelated models must survive, otherwise the assertion is vacuous"
  );
  assert.deepEqual(
    openRouterEntries(body).map((model) => model.id),
    []
  );
});
