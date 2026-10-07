import { resolve as researchResolve } from './fixtures/research_test_loader.mjs';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox/value') {
    const typebox = await researchResolve('typebox', context, nextResolve);
    return nextResolve(specifier, { ...context, parentURL: typebox.url });
  }
  return researchResolve(specifier, context, nextResolve);
}
