let availableModels = [];
let createError;
const createCalls = [];
const legacyCreateCalls = [];

async function createRuntime(options) {
  createCalls.push(options);
  if (createError) throw createError;
  return {
    async getAvailable() {
      return availableModels;
    },
  };
}

export class ModelRuntime {}
ModelRuntime.create = createRuntime;

export const AuthStorage = {
  create(authPath) {
    return { authPath };
  },
};

export class ModelRegistry {
  static create(auth, modelsPath) {
    legacyCreateCalls.push({ auth, modelsPath });
    return { getAvailable: () => availableModels };
  }
}

export function setPanelRuntimeModels(models) {
  availableModels = models;
  createError = undefined;
  createCalls.length = 0;
  legacyCreateCalls.length = 0;
  ModelRuntime.create = createRuntime;
}

export function setPanelRuntimeError(error) {
  createError = error;
  createCalls.length = 0;
  legacyCreateCalls.length = 0;
  ModelRuntime.create = createRuntime;
}

export function useLegacyPanelRuntime(models) {
  availableModels = models;
  createError = undefined;
  createCalls.length = 0;
  legacyCreateCalls.length = 0;
  ModelRuntime.create = undefined;
}

export function getPanelRuntimeCreateCalls() {
  return [...createCalls];
}

export function getLegacyPanelCreateCalls() {
  return [...legacyCreateCalls];
}
