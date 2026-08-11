import test from "node:test";
import assert from "node:assert/strict";
import {
	buildRoxPublicCatalog,
	getRoxPublicModelFallbackChain,
	getRoxPublicModelSpecs,
	isOpenRouterCatalogEntry,
	isRoxPublicModelId,
	ROX_FALLBACK_CHAINS,
} from "../../src/lib/roxPublicModelPolicy.ts";

test("ROX public catalog exposes stable endpoint IDs and hides upstream targets", () => {
  const specs = getRoxPublicModelSpecs();
  assert.deepEqual(
    specs.map((spec) => spec.id),
    ["rox/explore", "rox/standard", "rox/max", "rox/vision", "rox/fast"]
  );
  const catalog = buildRoxPublicCatalog(123);
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ["rox/explore", "rox/standard", "rox/max", "rox/vision", "rox/fast"]
  );
  assert.ok(catalog.every((entry) => entry.owned_by === "rox"));
  assert.ok(catalog.every((entry) => entry.parent === null));
  assert.ok(catalog.every((entry) => !String(entry.id).includes("opencode-go")));
});

test("ROX catalog filter recognizes every OpenRouter The Old LLM representation", () => {
  assert.equal(isOpenRouterCatalogEntry({ id: "openrouter_gpt_4_o", parent: "tllm/openrouter_gpt_4_o" }), true);
  assert.equal(isOpenRouterCatalogEntry({ id: "tllm/openrouter_grok_4", root: "openrouter_grok_4" }), true);
  assert.equal(isOpenRouterCatalogEntry({ id: "tllm/GPT_5_4", root: "GPT_5_4" }), false);
});

test("ROX fallback chains start with the public spec target and never downgrade max", () => {
  for (const spec of getRoxPublicModelSpecs()) {
    assert.equal(ROX_FALLBACK_CHAINS[spec.id]?.[0], spec.target);
  }
	assert.deepEqual(ROX_FALLBACK_CHAINS["rox/max"], ["opencode-go/kimi-k3"]);
});

test("ROX public IDs resolve to exact immutable fallback chains", () => {
	const expectedChains = {
		"rox/explore": ["kmc/kimi-for-coding", "opencode-go/kimi-k2.7-code", "opencode-go/kimi-k2.6"],
		"rox/standard": ["opencode-go/kimi-k2.6", "fireworks/kimi-k2p6", "baseten/moonshotai/Kimi-K2.6"],
		"rox/max": ["opencode-go/kimi-k3"],
		"rox/vision": ["agy/gemini-3.6-flash-high", "agy/gemini-2.5-flash"],
		"rox/fast": ["agy/gemini-3.6-flash-low", "agy/gemini-2.5-flash-lite"],
	};

	for (const spec of getRoxPublicModelSpecs()) {
		assert.equal(isRoxPublicModelId(spec.id), true);
		assert.equal(getRoxPublicModelFallbackChain(spec.id), ROX_FALLBACK_CHAINS[spec.id]);
		assert.deepEqual(getRoxPublicModelFallbackChain(spec.id), expectedChains[spec.id]);
		assert.equal(Object.isFrozen(getRoxPublicModelFallbackChain(spec.id)), true);
	}

	assert.equal(isRoxPublicModelId("rox/unknown"), false);
	assert.equal(getRoxPublicModelFallbackChain("rox/unknown"), null);
	assert.equal(isRoxPublicModelId("openai/gpt-5"), false);
	assert.equal(getRoxPublicModelFallbackChain("openai/gpt-5"), null);
	assert.equal(getRoxPublicModelFallbackChain(null), null);
	assert.deepEqual(getRoxPublicModelFallbackChain("rox/max"), ["opencode-go/kimi-k3"]);
	assert.equal(getRoxPublicModelFallbackChain("rox/max")?.length, 1);
});
