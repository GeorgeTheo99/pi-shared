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
import { loadProfileModels } from "../extensions/panel/index.ts";

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
