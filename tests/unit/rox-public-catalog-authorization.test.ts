import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rox-public-catalog-"));
const ORIGINAL_ROX_PUBLIC_CATALOG_ONLY = process.env.ROX_PUBLIC_CATALOG_ONLY;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "rox-public-catalog-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getRoxPublicModelSpecs, isRoxPublicModelId } = await import(
  "../../src/lib/roxPublicModelPolicy.ts"
);
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

interface ModelsCatalogResponseBody {
  data: Array<{ id: string }>;
}

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

function getCatalogIds(body: ModelsCatalogResponseBody): string[] {
  return body.data.map((model) => model.id);
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

test("ROX public catalog scopes DB-backed keys against declared rox IDs", async () => {
  process.env.ROX_PUBLIC_CATALOG_ONLY = "true";
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();

  const key = await apiKeysDb.createApiKey("rox-public-standard", "rox-public-machine");
  await apiKeysDb.updateApiKeyPermissions(key.id, {
    allowedModels: ["rox/standard"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models", {
      headers: { Authorization: `Bearer ${key.key}` },
    })
  );
  const body = (await response.json()) as ModelsCatalogResponseBody;

  assert.equal(response.status, 200);
  assert.deepEqual(getCatalogIds(body), ["rox/standard"]);
});

test("ROX public catalog suppresses every raw dispatch target", async () => {
  process.env.ROX_PUBLIC_CATALOG_ONLY = "true";
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as ModelsCatalogResponseBody;
  const ids = getCatalogIds(body);
  const specs = getRoxPublicModelSpecs();

  assert.equal(response.status, 200);
  assert.deepEqual(
    ids,
    specs.map((spec) => spec.id)
  );
  assert.ok(ids.every((id) => isRoxPublicModelId(id)));
  for (const spec of specs) {
    assert.equal(ids.includes(spec.target), false, `raw target must be hidden: ${spec.target}`);
  }
});

test("catalog keeps its normal provider projection when ROX public mode is disabled", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-rox-public-default",
    apiKey: "sk-test",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as ModelsCatalogResponseBody;
  const ids = getCatalogIds(body);

  assert.equal(response.status, 200);
  assert.ok(ids.some((id) => id.startsWith("openai/")));
  assert.equal(ids.some((id) => isRoxPublicModelId(id)), false);
});
