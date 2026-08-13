/**
 * Isolate the serialize-time OpenRouter strip in finalizeCatalogResponse.
 * Upstream catalog.ts already filters; this file feeds a mixed list so deleting
 * the exit filter turns this test red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-catalog-response-or-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-response-or-secret";

const { finalizeCatalogResponse } = await import("../../src/app/api/v1/models/catalogResponse.ts");

test.after(() => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("finalizeCatalogResponse drops OpenRouter rows the caller forgot to filter", async () => {
  const request = new Request("http://127.0.0.1/v1/models");
  const finalModels = [
    { id: "openrouter/test", owned_by: "openrouter", root: "test", parent: null },
    { id: "glm/kept", owned_by: "glm", root: "glm/kept", parent: null },
  ];
  const response = await finalizeCatalogResponse(request, finalModels, () => 8192, {});
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(body.data.map((model) => model.id).sort(), ["glm/kept"]);
});
