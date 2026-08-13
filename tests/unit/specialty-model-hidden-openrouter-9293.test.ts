/**
 * #9293 — specialty model catalog ignores hidden OpenRouter model flags.
 *
 * The specialty model loops (image, rerank, audio, moderation, video, music)
 * in catalog.ts reduce OpenRouter model IDs to only the final path segment
 * via .split("/").pop() before calling getModelIsHidden(), so stored hidden
 * flags with full provider-relative paths (e.g. openrouter+google/chirp-3)
 * are never matched. The embedding loop correctly strips only the provider prefix
 * rather than taking the last segment.
 *
 * This test: seeds an OpenRouter connection, hides two OpenRouter specialty
 * models (audio: google/chirp-3, image: black-forest-labs/flux.2-pro), then
 * verifies the hidden models are excluded from the /v1/models catalog.
 *
 * ROX divergence: this fork publishes no OpenRouter model at all, so the catalog
 * can no longer distinguish "hidden" from "visible" for this provider — the
 * non-hidden control (deepgram/nova-3) is withheld too. The hidden-flag storage
 * and path matching that #9293 fixed are asserted directly against
 * getModelIsHidden below; the catalog half now pins the ROX exclusion instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9293-specialty-hidden-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "9293-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { mergeModelCompatOverride, getModelIsHidden } = await import("../../src/lib/localDb.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("#9293 hidden OpenRouter specialty models are excluded from /v1/models catalog", async () => {
  // Create an active OpenRouter connection
  const connection = await providersDb.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: "openrouter-test",
    apiKey: "sk-or-test-9293",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  assert.ok(connection?.id, "OpenRouter connection created");

  // Confirm the hidden flag is not set yet
  assert.equal(
    getModelIsHidden("openrouter", "google/chirp-3"),
    false,
    "chirp-3 is initially visible"
  );
  assert.equal(
    getModelIsHidden("openrouter", "black-forest-labs/flux.2-pro"),
    false,
    "flux.2-pro is initially visible"
  );

  // Hide two OpenRouter specialty models: one audio, one image
  mergeModelCompatOverride("openrouter", "google/chirp-3", { isHidden: true });
  mergeModelCompatOverride("openrouter", "black-forest-labs/flux.2-pro", { isHidden: true });

  // Confirm the hidden flags are stored correctly
  assert.equal(getModelIsHidden("openrouter", "google/chirp-3"), true, "chirp-3 is now hidden");
  assert.equal(
    getModelIsHidden("openrouter", "black-forest-labs/flux.2-pro"),
    true,
    "flux.2-pro is now hidden"
  );

  // Fetch the full catalog
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string; type?: string }> };
  assert.ok(Array.isArray(body.data), "response has data array");

  // Find audio and image models
  const audioModels = body.data.filter((m) => m.type === "audio");
  const imageModels = body.data.filter((m) => m.type === "image");

  // chirp-3 model ID from the audio registry is openrouter/google/chirp-3
  const hiddenAudio = audioModels.find((m) => String(m.id).endsWith("google/chirp-3"));
  assert.equal(
    hiddenAudio,
    undefined,
    "#9293 RED: hidden audio model openrouter/google/chirp-3 should NOT appear in catalog"
  );

  // flux.2-pro model ID from the image registry is openrouter/black-forest-labs/flux.2-pro
  const hiddenImage = imageModels.find((m) =>
    String(m.id).endsWith("black-forest-labs/flux.2-pro")
  );
  assert.equal(
    hiddenImage,
    undefined,
    "#9293 RED: hidden image model openrouter/black-forest-labs/flux.2-pro should NOT appear in catalog"
  );

  // ROX: the non-hidden control is withheld as well — no OpenRouter specialty
  // model is published, hidden flag or not.
  const visibleAudio = audioModels.find((m) => String(m.id).endsWith("deepgram/nova-3"));
  assert.equal(visibleAudio, undefined, "ROX excludes OpenRouter audio models from the catalog");
  assert.deepEqual(
    body.data.filter((m) => String(m.id).startsWith("openrouter/")).map((m) => m.id),
    []
  );
});

test("#9293 nested specialty ids honor hidden flags on a non-OpenRouter provider", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "together",
    authType: "apikey",
    name: "together-9293",
    apiKey: "sk-together-9293",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  assert.ok(connection?.id, "Together connection created");

  mergeModelCompatOverride("together", "openai/whisper-large-v3", { isHidden: true });
  assert.equal(getModelIsHidden("together", "openai/whisper-large-v3"), true);

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string; type?: string }> };
  const audioModels = body.data.filter((m) => m.type === "audio");

  assert.equal(
    audioModels.find((m) => String(m.id) === "together/openai/whisper-large-v3"),
    undefined,
    "hidden nested together audio id must not appear — .split('/').pop() would miss this flag"
  );
  assert.ok(
    audioModels.find((m) => String(m.id) === "together/openai/whisper-large-v3-turbo"),
    "sibling nested together audio id must still appear so the hidden-flag path is not vacuous"
  );
});
