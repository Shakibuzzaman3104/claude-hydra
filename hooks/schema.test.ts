/**
 * @author Shakib
 * @since 11/11/26
 */

import { expect, test } from 'claude-code/testing'
import { extractJson, readReply, schemaFixNote, schemaNote, schemaProblem, validate } from './lib/schema'

test('schemaProblem rejects a value that is not a plain object', async () => {
  expect(schemaProblem(null)).toBe('schema must be an object')
  expect(schemaProblem([])).toBe('schema must be an object')
  expect(schemaProblem('object')).toBe('schema must be an object')
})

test('schemaProblem demands an object root type', async () => {
  expect(schemaProblem({ type: 'array' })).toBe('schema needs "type": "object" at its root')
  expect(schemaProblem({ properties: {} })).toBe('schema needs "type": "object" at its root')
})

test('schemaProblem demands a non-empty properties map', async () => {
  expect(schemaProblem({ type: 'object' })).toBe('schema needs "properties"')
  expect(schemaProblem({ type: 'object', properties: {} })).toBe('schema needs "properties"')
  expect(schemaProblem({ type: 'object', properties: [] })).toBe('schema needs "properties"')
})

test('schemaProblem demands required to be a list of names', async () => {
  expect(schemaProblem({ type: 'object', properties: { a: {} }, required: 'a' })).toBe('"required" must be a list of property names')
  expect(schemaProblem({ type: 'object', properties: { a: {} }, required: [1] })).toBe('"required" must be a list of property names')
})

test('schemaProblem rejects a required name that is not a property', async () => {
  expect(schemaProblem({ type: 'object', properties: { a: {} }, required: ['b'] })).toBe('"required" names "b", which is not in "properties"')
})

test('schemaProblem rejects a schema over 6000 characters', async () => {
  const schema = { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(7000) } } }
  expect(schemaProblem(schema)).toBe('schema is too large (over 6000 characters)')
})

test('schemaProblem accepts a small object schema', async () => {
  expect(schemaProblem({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] })).toBe(undefined)
})

test('validate checks each scalar type', async () => {
  expect(validate({ type: 'string' }, 'a')).toEqual([])
  expect(validate({ type: 'string' }, 1)).toEqual(['$: expected string, got number'])
  expect(validate({ type: 'boolean' }, true)).toEqual([])
  expect(validate({ type: 'boolean' }, 'true')).toEqual(['$: expected boolean, got string'])
  expect(validate({ type: 'array' }, [])).toEqual([])
  expect(validate({ type: 'array' }, {})).toEqual(['$: expected array, got object'])
  expect(validate({ type: 'object' }, {})).toEqual([])
  expect(validate({ type: 'object' }, null)).toEqual(['$: expected object, got null'])
  expect(validate({ type: 'object' }, [])).toEqual(['$: expected object, got array'])
  expect(validate({ type: 'null' }, null)).toEqual([])
  expect(validate({ type: 'null' }, 0)).toEqual(['$: expected null, got number'])
})

test('validate separates integer from number', async () => {
  expect(validate({ type: 'integer' }, 2)).toEqual([])
  expect(validate({ type: 'integer' }, 2.5)).toEqual(['$: expected integer, got number'])
  expect(validate({ type: 'number' }, 2.5)).toEqual([])
  expect(validate({ type: 'number' }, Number.POSITIVE_INFINITY)).toEqual(['$: expected number, got number'])
})

test('validate accepts any type in a type list', async () => {
  expect(validate({ type: ['string', 'null'] }, null)).toEqual([])
  expect(validate({ type: ['string', 'null'] }, 'a')).toEqual([])
  expect(validate({ type: ['string', 'null'] }, 3)).toEqual(['$: expected string or null, got number'])
})

test('validate checks enum membership strictly', async () => {
  expect(validate({ enum: ['a', 'b'] }, 'a')).toEqual([])
  expect(validate({ enum: ['a', 'b'] }, 'c')).toEqual(['$: must be one of ["a","b"]'])
})

test('validate reports missing required properties', async () => {
  expect(validate({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, {})).toEqual(['$.a: missing'])
  expect(validate({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { a: 'x' })).toEqual([])
})

test('validate descends into nested objects and arrays with paths', async () => {
  const schema = {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: { type: 'object', properties: { line: { type: 'number' } }, required: ['line'] }
      }
    }
  }
  expect(validate(schema, { findings: [{ line: 1 }, {}] })).toEqual(['$.findings[1].line: missing'])
})

test('validate rejects extra keys when additionalProperties is false', async () => {
  const schema = { type: 'object', properties: { a: {} }, additionalProperties: false }
  expect(validate(schema, { a: 1, b: 2 })).toEqual(['$.b: not allowed'])
  expect(validate(schema, { a: 1 })).toEqual([])
})

test('validate enforces minItems and maxItems', async () => {
  expect(validate({ type: 'array', minItems: 2 }, [1])).toEqual(['$: needs at least 2 item(s)'])
  expect(validate({ type: 'array', maxItems: 3 }, [1, 2, 3, 4])).toEqual(['$: takes at most 3 item(s)'])
  expect(validate({ type: 'array', minItems: 1, maxItems: 3 }, [1, 2])).toEqual([])
})

test('validate stops after twenty messages', async () => {
  expect(validate({ type: 'array', items: { type: 'number' } }, new Array(30).fill('x')).length).toBe(20)
})

test('validate ignores unknown keywords', async () => {
  const schema = { type: 'string', pattern: '^a$' } as unknown as { type: 'string' }
  expect(validate(schema, 'anything')).toEqual([])
})

test('extractJson reads a single json block', async () => {
  expect(extractJson('Here you go\n```json\n{"a":1}\n```\n')).toEqual({ value: { a: 1 } })
})

test('extractJson takes the last json block', async () => {
  expect(extractJson('```json\n{"a":1}\n```\nand\n```json\n{"a":2}\n```')).toEqual({ value: { a: 2 } })
})

test('extractJson accepts an upper-case JSON fence', async () => {
  expect(extractJson('```JSON\n{"a":1}\n```')).toEqual({ value: { a: 1 } })
})

test('extractJson accepts a bare fence holding an object', async () => {
  expect(extractJson('```\n{"a":1}\n```')).toEqual({ value: { a: 1 } })
})

test('extractJson finds an object inside prose with tricky strings', async () => {
  const text = 'The result is {"note": "a } and \\"quote\\"", "n": 2} done'
  expect(extractJson(text)).toEqual({ value: { note: 'a } and "quote"', n: 2 } })
})

test('extractJson reports when nothing is there', async () => {
  expect(extractJson('no json here')).toEqual({ error: 'no JSON block in the reply' })
})

test('extractJson reports a block that does not parse', async () => {
  expect(JSON.stringify(extractJson('```json\n{nope}\n```'))).toContain('the JSON block does not parse')
})

test('schemaNote carries the pretty schema and the instruction', async () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } }
  const note = schemaNote(schema)
  expect(note).toContain('Answer format')
  expect(note).toContain(JSON.stringify(schema, null, 1))
})

test('schemaFixNote lists at most ten errors', async () => {
  const errors = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12']
  const note = schemaFixNote(errors)
  expect(note.split('\n').filter(line => line.startsWith('- ')).length).toBe(10)
  expect(note).toContain('- e1')
})

test('readReply returns data for a good reply', async () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  expect(readReply(schema, '```json\n{"name":"x"}\n```')).toEqual({ data: { name: 'x' } })
})

test('readReply reports a missing block', async () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } } }
  expect(readReply(schema, 'nothing here')).toEqual({ errors: ['no JSON block in the reply'] })
})

test('readReply reports a block that breaks the schema', async () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  expect(readReply(schema, '```json\n{}\n```')).toEqual({ errors: ['$.name: missing'] })
})
