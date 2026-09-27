import assert from 'node:assert/strict';
import test from 'node:test';
import anthropicSchema from '../extensions/anthropic-schema/index.ts';

test('Anthropic payload drops unsupported numeric bounds without modifying local tool schemas', () => {
  let handler: (event: any, ctx: any) => unknown = () => { throw new Error('not registered'); };
  anthropicSchema({ on(name: string, callback: typeof handler) {
    assert.equal(name, 'before_provider_request');
    handler = callback;
  } } as any);

  const inputSchema = {
    type: 'object', properties: {
      duration: { type: 'number', minimum: 0.001, maximum: 86400, description: 'Seconds' },
      port: { type: 'integer', minimum: 1, maximum: 65535 },
      optional: { type: ['integer', 'null'], minimum: 1 },
      implicit: { minimum: 2 },
      value: { type: 'object', default: { type: 'number', minimum: 7 } },
      nested: { type: 'array', minItems: 1, items: { anyOf: [
        { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 100, multipleOf: 2 },
        { type: 'string', minLength: 1 },
      ] } },
    }, required: ['duration'],
  };
  const payload = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged' }],
    tools: [{ name: 'command_start', input_schema: inputSchema }, { name: 'plain', input_schema: { type: 'object' } }] };
  const result = handler({ payload }, { model: { provider: 'anthropic' } }) as typeof payload;
  assert.deepEqual(result.tools[0].input_schema, {
    type: 'object', properties: {
      duration: { type: 'number', description: 'Seconds' },
      port: { type: 'integer' },
      optional: { type: ['integer', 'null'] },
      implicit: {},
      value: { type: 'object', default: { type: 'number', minimum: 7 } },
      nested: { type: 'array', minItems: 1, items: { anyOf: [
        { type: 'integer' }, { type: 'string', minLength: 1 },
      ] } },
    }, required: ['duration'],
  });
  assert.equal(result.messages, payload.messages);
  assert.equal(inputSchema.properties.port.minimum, 1);
  assert.equal(inputSchema.properties.duration.maximum, 86400);
  assert.equal(handler({ payload }, { model: { provider: 'openai-codex' } }), undefined);
  assert.equal(handler({ payload: { model: 'claude-sonnet-4-6' } }, { model: { provider: 'anthropic' } }), undefined);
});
