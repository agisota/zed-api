import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
import { ROX_FALLBACK_CHAINS } from "../../src/lib/roxPublicModelPolicy.ts";
import { reloadResourcePressureRuntime } from "../../open-sse/utils/resourcePressure.ts";

const harness = await createChatPipelineHarness("rox-local-pressure-fallback");
const { BaseExecutor, buildOpenAIResponse, buildRequest, handleChat, resetStorage, seedConnection, settingsDb } =
  harness;
const STANDARD_CHAIN = ROX_FALLBACK_CHAINS["rox/standard"];
const MiB = 1024 ** 2;

function requestForRoxStandard() {
  return buildRequest({
    url: "http://localhost/v1/chat/completions",
    body: {
      model: "rox/standard",
      messages: [{ role: "user", content: "Reply with OK only." }],
      stream: false,
    },
  });
}

function upstreamFailure(status: number) {
  return new Response(JSON.stringify({ error: { message: `upstream ${status}` } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function seedStandardChain() {
  await seedConnection("opencode-go", { apiKey: "rox-opencode-go" });
  await seedConnection("fireworks", { apiKey: "rox-fireworks" });
  await seedConnection("baseten", { apiKey: "rox-baseten" });
}

function restoreNonSheddingRuntime() {
  reloadResourcePressureRuntime({
    heapThresholdMb: 10_000,
    immediateHeapUsedMb: () => 1,
    sample: async () => ({
      observedAtMs: Date.now(),
      v8: { heapUsedBytes: MiB, heapLimitBytes: 10_000 * MiB },
      process: {
        rssBytes: MiB,
        externalBytes: 0,
        arrayBuffersBytes: 0,
        availableBytes: null,
        constrainedBytes: null,
      },
      cgroup: { currentBytes: null, maxBytes: null, highBytes: null, events: null },
      psi: null,
    }),
  });
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  restoreNonSheddingRuntime();
});

test.after(async () => {
  restoreNonSheddingRuntime();
  await resetStorage();
  await harness.cleanup();
});

test("ROX local resource pressure is terminal before any upstream attempt", async () => {
  await seedStandardChain();
  reloadResourcePressureRuntime({
    heapThresholdMb: 100,
    immediateHeapUsedMb: () => 999,
    sample: async () => {
      throw new Error("resource sampler must not run on the request path");
    },
  });

  let upstreamAttempts = 0;
  globalThis.fetch = async () => {
    upstreamAttempts += 1;
    return buildOpenAIResponse("unexpected upstream response");
  };

  const response = await handleChat(requestForRoxStandard());

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "resource_pressure");
  assert.equal(upstreamAttempts, 0);
});

test("ROX continues its bounded chain for a genuine upstream retryable response", async () => {
  await seedStandardChain();
  let upstreamAttempts = 0;
  globalThis.fetch = async () => {
    upstreamAttempts += 1;
    return upstreamFailure(503);
  };

  const response = await handleChat(requestForRoxStandard());

  assert.equal(response.status, 503);
  assert.equal(upstreamAttempts, STANDARD_CHAIN.length);
});
