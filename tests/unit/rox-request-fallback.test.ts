import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
import { ROX_FALLBACK_CHAINS } from "../../src/lib/roxPublicModelPolicy.ts";

const harness = await createChatPipelineHarness("rox-request-fallback");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  callLogsDb,
  handleChat,
  resetStorage,
  seedConnection,
  settingsDb,
  waitFor,
} = harness;

const STANDARD_CHAIN = ROX_FALLBACK_CHAINS["rox/standard"];

const STANDARD_TARGETS = STANDARD_CHAIN.map((target) => {
  const separator = target.indexOf("/");
  return {
    provider: target.slice(0, separator),
    model: target.slice(separator + 1),
  };
});

type Endpoint = "/v1/chat/completions" | "/v1/responses";
type UpstreamAttempt = {
  url: string;
  body: Record<string, unknown>;
};

function requestFor(model: "rox/standard" | "rox/max", endpoint: Endpoint) {
  const body =
    endpoint === "/v1/responses"
      ? { model, input: "Reply with OK only.", stream: false }
      : {
          model,
          messages: [{ role: "user", content: "Reply with OK only." }],
          stream: false,
        };

  return buildRequest({ url: `http://localhost${endpoint}`, body });
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

async function getRoxAttemptLogs(expectedCount: number) {
  return waitFor(async () => {
    const rows = await callLogsDb.getCallLogs({ limit: 20 });
    const roxRows = rows.filter(
      (row: { comboName?: string | null; comboStepId?: string | null }) =>
        row.comboName === "rox-public:rox/standard" && row.comboStepId
    );
    return roxRows.length === expectedCount ? roxRows : null;
  });
}

function orderRoxAttemptLogs(
  rows: Array<{
    comboStepId: string | null;
    model: string;
    provider: string;
    requestedModel: string | null;
  }>
) {
  return [...rows].sort((a, b) => (a.comboStepId || "").localeCompare(b.comboStepId || ""));
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
});

test.afterEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

for (const endpoint of ["/v1/chat/completions", "/v1/responses"] as const) {
  test(`rox/standard retries 503 through the shared ${endpoint} path in chain order`, async () => {
    await seedStandardChain();
    const upstreamAttempts: UpstreamAttempt[] = [];
    const responses = [upstreamFailure(503), buildOpenAIResponse("fallback succeeded")];

    globalThis.fetch = async (url, init = {}) => {
      upstreamAttempts.push({
        url: String(url),
        body: JSON.parse(String((init as RequestInit).body)),
      });
      return responses.shift()!;
    };

    const response = await handleChat(requestFor("rox/standard", endpoint));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, "rox/standard");

    const logs = await getRoxAttemptLogs(2);
    assert.ok(logs, "expected both ROX attempts to be recorded");
    const orderedLogs = orderRoxAttemptLogs(logs);
    assert.deepEqual(
      orderedLogs.map((row) => row.model),
      STANDARD_TARGETS.slice(0, 2).map((target) => target.model)
    );
    assert.deepEqual(
      orderedLogs.map((row) => row.provider),
      STANDARD_TARGETS.slice(0, 2).map((target) => target.provider)
    );
    assert.ok(orderedLogs.every((row) => row.requestedModel === "rox/standard"));
  });
}

for (const status of [400, 401, 403, 422]) {
  test(`rox/standard returns the original ${status} without advancing`, async () => {
    await seedStandardChain();
    const original = upstreamFailure(status);
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return original;
    };

    const response = await handleChat(requestFor("rox/standard", "/v1/chat/completions"));

    assert.equal(attempts, 1);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.message, `[${status}]: upstream ${status}`);
  });
}

for (const status of [429, 502, 504]) {
  test(`rox/standard caps ${status} retries at its fallback-chain length`, async () => {
    await seedStandardChain();
    const upstreamAttempts: UpstreamAttempt[] = [];
    globalThis.fetch = async (url, init = {}) => {
      upstreamAttempts.push({
        url: String(url),
        body: JSON.parse(String((init as RequestInit).body)),
      });
      return upstreamFailure(status);
    };

    const response = await handleChat(requestFor("rox/standard", "/v1/chat/completions"));
    const logs = await getRoxAttemptLogs(STANDARD_CHAIN.length);

    assert.equal(response.status, status);
    assert.equal(upstreamAttempts.length, STANDARD_CHAIN.length);
    assert.ok(logs, "expected every fallback target to have an attempt log");
    const orderedLogs = orderRoxAttemptLogs(logs);
    assert.deepEqual(
      orderedLogs.map((row) => row.model),
      STANDARD_TARGETS.map((target) => target.model)
    );
    assert.deepEqual(
      orderedLogs.map((row) => row.provider),
      STANDARD_TARGETS.map((target) => target.provider)
    );
  });
}

test("rox/max keeps its one-target contract after a retryable 503", async () => {
  await seedConnection("opencode-go", { apiKey: "rox-opencode-go" });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return upstreamFailure(503);
  };

  const response = await handleChat(requestFor("rox/max", "/v1/chat/completions"));

  assert.equal(response.status, 503);
  assert.equal(attempts, 1);
});
