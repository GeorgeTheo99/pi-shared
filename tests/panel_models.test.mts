import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getLegacyPanelCreateCalls,
  getPanelRuntimeCreateCalls,
  setPanelRuntimeError,
  setPanelRuntimeModels,
  useLegacyPanelRuntime,
} from "./fixtures/panel_test_pi_stub.mjs";
import { formatModelList, loadProfileModels, selectModels } from "../extensions/panel/index.ts";

async function profileDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-panel-test-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "models.json"), '{"providers":{}}\n');
  return agentDir;
}

test("alternate-profile discovery uses the async ModelRuntime API", async () => {
  const agentDir = await profileDir();
  setPanelRuntimeModels([
    {
      provider: "local-provider",
      id: "glm-test",
      input: ["text", "image"],
      contextWindow: 131_072,
      maxTokens: 32_768,
      reasoning: true,
    },
  ]);

  const models = await loadProfileModels(agentDir);

  assert.equal(models.length, 1);
  assert.deepEqual(models[0], {
    provider: "local-provider",
    id: "glm-test",
    key: "local-provider/glm-test",
    family: "glm",
    contextWindow: 131_072,
    maxTokens: 32_768,
    reasoning: true,
    images: true,
    agentDir,
    source: "profile",
  });
  assert.deepEqual(getPanelRuntimeCreateCalls(), [
    {
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
    },
  ]);
});

test("Pi 0.80.7 alternate profiles retain the legacy registry fallback", async () => {
  const agentDir = await profileDir();
  useLegacyPanelRuntime([{ provider: "legacy", id: "legacy-model", input: ["text"] }]);

  const models = await loadProfileModels(agentDir);

  assert.equal(models[0]?.key, "legacy/legacy-model");
  assert.deepEqual(getLegacyPanelCreateCalls(), [
    {
      auth: { authPath: path.join(agentDir, "auth.json") },
      modelsPath: path.join(agentDir, "models.json"),
    },
  ]);
});

test("an unavailable alternate profile does not break current-profile discovery", async () => {
  const agentDir = await profileDir();
  setPanelRuntimeError(new Error("bad profile"));

  assert.deepEqual(await loadProfileModels(agentDir), []);
});

const selectionModels = [
  {
    provider: "cloud",
    id: "text-model",
    key: "cloud/text-model",
    family: "glm",
    contextWindow: 100_000,
    maxTokens: 10_000,
    reasoning: true,
    images: false,
    source: "current" as const,
  },
  {
    provider: "cloud",
    id: "vision-model",
    key: "cloud/vision-model",
    family: "gemini",
    contextWindow: 90_000,
    maxTokens: 10_000,
    reasoning: true,
    images: true,
    source: "current" as const,
  },
];

test("image-dependent panel selection excludes text-only models", () => {
  const selected = selectModels(selectionModels, {}, {
    current: "cloud/text-model",
    requiresImages: true,
  });

  assert.deepEqual(selected.selected.map((model) => model.key), ["cloud/vision-model"]);
  assert.equal(selected.current?.key, "cloud/text-model");
});

test("ordinary explicit panel selection retains exact and fuzzy matching", () => {
  const exact = selectModels(selectionModels, {}, { explicit: ["cloud/text-model"] });
  const fuzzy = selectModels(selectionModels, {}, { explicit: ["vision"] });

  assert.deepEqual(exact.selected.map((model) => model.key), ["cloud/text-model"]);
  assert.deepEqual(fuzzy.selected.map((model) => model.key), ["cloud/vision-model"]);
});

test("explicit text-only panel selection fails closed when images are required", () => {
  const selected = selectModels(
    [
      ...selectionModels,
      { ...selectionModels[1], id: "text-model-vision", key: "cloud/text-model-vision" },
    ],
    {},
    {
      explicit: ["cloud/text-model"],
      requiresImages: true,
    },
  );

  assert.deepEqual(selected.selected, []);
  assert.deepEqual(selected.unresolved, ["cloud/text-model"]);
});

test("image-dependent selection does not reuse the current or excluded model", () => {
  const onlyCurrent = selectModels([selectionModels[1]], {}, {
    current: "cloud/vision-model",
    requiresImages: true,
  });
  const excluded = selectModels(selectionModels, { excludeModels: ["vision-model"] }, {
    current: "cloud/text-model",
    requiresImages: true,
  });
  const explicitCurrent = selectModels(selectionModels, {}, {
    current: "cloud/vision-model",
    explicit: ["cloud/vision-model"],
    requiresImages: true,
  });
  const explicitExcluded = selectModels(selectionModels, { excludeModels: ["vision-model"] }, {
    explicit: ["cloud/vision-model"],
    requiresImages: true,
  });

  assert.deepEqual(onlyCurrent.selected, []);
  assert.deepEqual(excluded.selected, []);
  assert.deepEqual(explicitCurrent.selected, []);
  assert.deepEqual(explicitCurrent.unresolved, ["cloud/vision-model"]);
  assert.deepEqual(explicitExcluded.selected, []);
  assert.deepEqual(explicitExcluded.unresolved, ["cloud/vision-model"]);
});

test("panel model lists disclose vision capability", () => {
  const formatted = formatModelList(selectionModels);

  assert.match(formatted, /cloud\/text-model \(glm ctx:100K thinking text-only\)/);
  assert.match(formatted, /cloud\/vision-model \(gemini ctx:90K thinking vision\)/);
});

function gptModel(provider: string, id: string, agentDir: string) {
  return {
    provider, id, key: `${provider}/${id}`, family: "gpt", contextWindow: 272_000, maxTokens: 128_000,
    reasoning: true, images: true, agentDir, source: "profile" as const,
  };
}

async function signedInProfile(auth: Record<string, unknown>): Promise<string> {
  const agentDir = await profileDir();
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify(auth));
  return agentDir;
}

test("GPT panel choices prefer Sign in with ChatGPT and treat an OpenAI API key as API-routed", async () => {
  const subscription = await signedInProfile({ openai: { type: "oauth" }, "openai-codex": { type: "oauth" } });
  const apiKey = await signedInProfile({ openai: { type: "api_key", key: "test-only" } });
  const glm = { ...selectionModels[0], family: "glm" };
  const pick = (models: ReturnType<typeof gptModel>[]) =>
    selectModels([glm, ...models], {}, { current: glm.key }).selected.map((model) => model.key);

  assert.deepEqual(pick([gptModel("openai-codex", "gpt-6-sol", subscription), gptModel("openai", "gpt-6-sol", subscription)]),
    ["openai/gpt-6-sol"]);
  assert.deepEqual(pick([gptModel("openai", "gpt-6-astra", apiKey), gptModel("openai-codex", "gpt-6-sol", subscription)]),
    ["openai-codex/gpt-6-sol"]);
});

test("compare mode counts openai/X and openai-codex/X as one subscription model", async () => {
  const subscription = await signedInProfile({ openai: { type: "oauth" }, "openai-codex": { type: "oauth" } });
  const models = [gptModel("openai", "gpt-6-sol", subscription), gptModel("openai-codex", "gpt-6-sol", subscription),
    gptModel("openai", "gpt-6-luna", subscription)];
  const keys = selectModels(models, {}, { mode: "compare", count: 3 }).selected.map((model) => model.key);
  assert.equal(keys.length, 2);
  assert.ok(keys.includes("openai/gpt-6-luna"));
  assert.equal(keys.filter((key) => key.endsWith("/gpt-6-sol")).length, 1);
});
