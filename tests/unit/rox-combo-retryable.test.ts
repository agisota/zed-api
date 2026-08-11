import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rox-combo-retryable-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "rox-combo-retryable-test-secret";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };
const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];
const TERMINAL_STATUSES = [400, 401, 403, 404, 422, 499];

function roxPriorityCombo() {
  return {
    name: "rox-priority-retryable",
    strategy: "priority",
    models: ["first/model", "second/model"],
    config: { maxRetries: 0, roxPriorityRetryableOnly: true },
  };
}

function response(status: number, code?: string) {
  return new Response(JSON.stringify({ error: { code, message: `status ${status}` } }), {
    status,
    headers: { "content-type": "application/json", "x-upstream-response": "original" },
  });
}

test(
  "ROX retryable-only priority combo advances only for retryable upstream statuses",
  async () => {
    for (const status of RETRYABLE_STATUSES) {
      const calls: string[] = [];
      const result = await handleComboChat({
        body: { model: "rox-priority-retryable", messages: [] },
        combo: roxPriorityCombo(),
        handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
          calls.push(modelStr);
          return calls.length === 1 ? response(status) : Response.json({ ok: true });
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        allCombos: null,
      });

      assert.equal(result.status, 200, `${status} should advance to the second target`);
      assert.deepEqual(calls, ["first/model", "second/model"]);
    }
  }
);

test(
  "ROX retryable-only priority combo returns terminal upstream responses unchanged",
  async () => {
    for (const status of TERMINAL_STATUSES) {
      const original = response(status);
      let calls = 0;
      const result = await handleComboChat({
        body: { model: "rox-priority-retryable", messages: [] },
        combo: roxPriorityCombo(),
        handleSingleModel: async () => {
          calls++;
          return original;
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        allCombos: null,
      });

      assert.equal(calls, 1, `${status} must not advance to another target`);
      assert.strictEqual(result, original, `${status} must preserve the original response`);
      assert.equal(result.headers.get("x-upstream-response"), "original");
    }
  }
);

test(
  "ROX retryable-only priority combo does not advance on a local API-key token-limit 429",
  async () => {
    const original = response(429, "TOKEN_LIMIT_EXCEEDED");
    let calls = 0;
    const result = await handleComboChat({
      body: { model: "rox-priority-retryable", messages: [] },
      combo: roxPriorityCombo(),
      handleSingleModel: async () => {
        calls++;
        return original;
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
    });

    assert.equal(calls, 1, "a local token-limit envelope must not advance the combo");
    assert.strictEqual(result, original);
  }
);

test("priority combos without the ROX flag retain generic fallback behavior", async () => {
  const calls: string[] = [];
  const result = await handleComboChat({
    body: { model: "generic-priority", messages: [] },
    combo: {
      ...roxPriorityCombo(),
      name: "generic-priority",
      config: { maxRetries: 0 },
    },
    handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return calls.length === 1 ? response(403) : Response.json({ ok: true });
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(calls, ["first/model", "second/model"]);
});
