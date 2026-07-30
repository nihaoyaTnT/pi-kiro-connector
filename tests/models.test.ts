import assert from "node:assert/strict";
import test from "node:test";
import {
  displayName,
  fallbackModels,
  hasImageCapability,
  hasLargeContext,
  supportsReasoning,
  toModelConfig,
} from "../src/models.ts";

test("detects image capabilities across native catalog response shapes", () => {
  assert.equal(hasImageCapability({ supports_image: true }), true);
  assert.equal(hasImageCapability({ input_modalities: ["text", "image"] }), true);
  assert.equal(hasImageCapability({ modalities: { input: ["text", "vision"] } }), true);
  assert.equal(hasImageCapability({ input_modalities: ["text"] }), false);
});

test("classifies large Claude context windows", () => {
  assert.equal(hasLargeContext("claude-sonnet-4.6"), true);
  assert.equal(hasLargeContext("claude-opus-4-7"), true);
  assert.equal(hasLargeContext("claude-sonnet-5"), true);
  assert.equal(hasLargeContext("claude-sonnet-4.5"), false);
  assert.equal(hasLargeContext("gpt-4o"), false);
});

test("filters thinking aliases and maps model metadata", () => {
  assert.equal(toModelConfig({ id: "claude-sonnet-4.6-thinking" }), undefined);
  const model = toModelConfig({
    id: "claude-sonnet-4.6",
    modalities: { input: ["text", "image"] },
  });
  assert.ok(model);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 64_000);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
});

test("prefers catalog metadata over name-based defaults", () => {
  const model = toModelConfig({
    id: "future-model",
    name: "Future Model",
    reasoning: true,
    context_window: 345_678,
    max_tokens: 12_345,
    input_modalities: ["text", "image"],
  });
  assert.ok(model);
  assert.equal(model.name, "Future Model (Kiro)");
  assert.equal(model.reasoning, true);
  assert.equal(model.contextWindow, 345_678);
  assert.equal(model.maxTokens, 12_345);
  assert.deepEqual(model.input, ["text", "image"]);
});

test("uses conservative reasoning defaults for aliases", () => {
  assert.equal(supportsReasoning({}, "claude-sonnet-4.6"), true);
  assert.equal(supportsReasoning({}, "gpt-4o"), false);
  assert.equal(supportsReasoning({}, "auto"), false);
  assert.equal(supportsReasoning({ supports_reasoning: true }, "gpt-4o"), true);
});

test("marks auto as non-reasoning and creates readable names", () => {
  const auto = toModelConfig("auto");
  assert.ok(auto);
  assert.equal(auto.reasoning, false);
  assert.equal(displayName("gpt-4o"), "GPT 4o (Kiro)");
});

test("provides unique fallback models", () => {
  const models = fallbackModels();
  assert.ok(models.length > 0);
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);
});
