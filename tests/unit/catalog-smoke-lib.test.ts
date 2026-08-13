import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_IDS,
  assertExactPublicIds,
  assertNormalCatalogHonesty,
} from "../../scripts/ad-hoc/catalog-smoke-lib.ts";

test("assertExactPublicIds accepts only the five public ROX ids", () => {
  assert.doesNotThrow(() => assertExactPublicIds([...PUBLIC_IDS]));
  assert.throws(
    () =>
      assertExactPublicIds([
        "rox/explore",
        "rox/standard",
        "rox/max",
        "rox/vision",
        "rox/fast",
        "extra",
      ]),
    /exactly/
  );
});

test("assertNormalCatalogHonesty rejects an empty 200 catalog", () => {
  assert.throws(() => assertNormalCatalogHonesty([]), /empty catalog/);
});

test("assertNormalCatalogHonesty rejects OpenRouter rows and accepts a populated non-OpenRouter catalog", () => {
  assert.throws(
    () =>
      assertNormalCatalogHonesty([
        { id: "glm/kept", owned_by: "glm" },
        { id: "openrouter/openai/gpt-4o", owned_by: "openrouter" },
      ]),
    /OpenRouter leaked/
  );
  assert.doesNotThrow(() =>
    assertNormalCatalogHonesty([
      { id: "glm/kept", owned_by: "glm" },
      { id: "kmc/kimi-for-coding", owned_by: "kmc" },
    ])
  );
});
