import assert from 'node:assert/strict';
import test from 'node:test';
import anthropicSchema from '../extensions/anthropic-schema/index.ts';

test('Anthropic payload drops unsupported tool constraints without modifying local schemas', () => {
  let handler: (event: any, ctx: any) => unknown = () => { throw new Error('not registered'); };
  anthropicSchema({
    getAllTools() { throw new Error('Must not substitute current definitions for transcript schemas'); },
    on(name: string, callback: typeof handler) {
      assert.equal(name, 'before_provider_request');
      handler = callback;
    },
  } as any);

  const inputSchema = {
    type: 'object', properties: {
      duration: { type: 'number', minimum: 0.001, maximum: 86400, description: 'Seconds' },
      port: { type: 'integer', minimum: 1, maximum: 65535 },
      optional: { type: ['integer', 'null'], minimum: 1 },
      implicit: { minimum: 2 },
      value: { type: 'object', minProperties: 1, default: { type: 'number', minimum: 7 } },
      nested: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: { anyOf: [
        { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 100, multipleOf: 2 },
        { type: 'string', minLength: 1, maxLength: 100, pattern: '^a' },
      ] } },
      tuple: { type: 'array', items: [{ type: 'string', minLength: 1 }], contains: { type: 'string', minLength: 2 } },
    }, required: ['duration'],
  };
  const payload = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged' }],
    tools: [{ name: 'command_start', input_schema: inputSchema }, { name: 'plain', input_schema: { type: 'object' } },
      { name: 'Read', strict: true, input_schema: { type: 'object', properties: {
        offset: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        requiredNullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        optionalNullable: { type: ['string', 'null'] },
        nested: { type: 'object', properties: {
          step: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        }, required: ['step'], additionalProperties: false },
      }, required: ['offset', 'requiredNullable', 'optionalNullable', 'nested'], additionalProperties: false } },
      { name: 'read', strict: true, input_schema: { type: 'object', properties: {
        path: { type: 'string', minLength: 1 },
      }, required: ['path'] } }] };
  const result = handler({ payload }, { model: { provider: 'anthropic' } }) as typeof payload;
  assert.deepEqual(result.tools[0].input_schema, {
    type: 'object', properties: {
      duration: { type: 'number', description: 'Seconds' },
      port: { type: 'integer' },
      optional: { type: ['integer', 'null'] },
      implicit: {},
      value: { type: 'object', default: { type: 'number', minimum: 7 } },
      nested: { type: 'array', items: { anyOf: [
        { type: 'integer' }, { type: 'string' },
      ] } },
      tuple: { type: 'array', items: [{ type: 'string' }], contains: { type: 'string' } },
    }, required: ['duration'],
  });
  assert.equal(result.messages, payload.messages);
  assert.deepEqual(result.tools[2], { name: 'Read', input_schema: { type: 'object',
    properties: {
      offset: { type: 'integer' }, requiredNullable: { type: 'string' },
      optionalNullable: { type: ['string', 'null'] },
      nested: { type: 'object', properties: { step: { type: 'integer' } },
        required: [], additionalProperties: false },
    }, required: ['optionalNullable', 'nested'], additionalProperties: false } });
  assert.deepEqual(result.tools[3], { name: 'read', input_schema: { type: 'object',
    properties: { path: { type: 'string' } }, required: ['path'] } });
  assert.equal('strict' in payload.tools[2] && payload.tools[2].strict, true);
  assert.equal(inputSchema.properties.port.minimum, 1);
  assert.equal(inputSchema.properties.duration.maximum, 86400);
  assert.equal(handler({ payload }, { model: { provider: 'openai-codex' } }), undefined);
  assert.equal(handler({ payload: { model: 'claude-sonnet-4-6' } }, { model: { provider: 'anthropic' } }), undefined);
});
