/**
 * @author Shakib
 * @since 25/11/26
 */
import { expect, test } from 'claude-code/testing'
import { agyBlockedUntil, agyLivePool, parseAgyUsage } from './engines/agy'
import { AGY_LEAD_POLICY } from './lib/policy'
import { AGY_MODELS, agyCurrentModel, agyModelId, isModelFor, modelAlternates, usagePoolOf } from './lib/engines'

const USAGE = '{"event":"command_result","command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models.","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.3758058547973633,"reset_time":"2026-12-01T02:55:58Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.9563037157058716,"reset_time":"2026-11-25T05:55:53Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0,"reset_time":"2026-11-29T10:22:25Z"},{"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","disabled":true,"remaining_fraction":1}]}]}}}'

test('usage lists model membership and blocks only the spent group', async () => {
  const buckets = parseAgyUsage(USAGE)
  expect(buckets[0]?.models).toEqual(['gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-carbon', 'gemini-3.8-flash', 'gemini-4-argon'])
  expect(buckets[2]?.models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-oss-120b'])
  expect(agyLivePool(buckets, 'gemini-4-argon')).toBe('gemini')
  expect(agyBlockedUntil(buckets, 'claude-sonnet-5-5')).toBe(Date.parse('2026-11-29T10:22:25Z'))
  expect(agyBlockedUntil(buckets, 'gemini-4-neon')).toBeUndefined()
})

test('split groups and older separate Argon groups follow their membership', async () => {
  const usage = (groups: unknown[]) => JSON.stringify({ event: 'command_result', command: { name: 'usage', data: { groups } } })
  const group = (name: string, models: string, remaining: number) => ({ name, description: `Models within this group: ${models}`, buckets: [{ window: 'weekly', remaining_fraction: remaining, reset_time: '2026-12-01T00:00:00Z' }] })
  const split = parseAgyUsage(usage([group('Opus', 'Claude Opus 5.5', 0), group('Sonnet', 'Claude Sonnet 5.5', 1)]))
  expect(agyBlockedUntil(split, 'claude-opus-5-5')).toBe(Date.parse('2026-12-01T00:00:00Z'))
  expect(agyBlockedUntil(split, 'claude-sonnet-5-5')).toBeUndefined()
  expect(agyLivePool(split, 'claude-sonnet-5-5')).toBe('sonnet')
  const old = parseAgyUsage(usage([group('Gemini Models', 'Gemini 4 Hydrogen', 1), group('Gemini 4 Argon', 'Gemini 4 Argon', 0)]))
  expect(agyLivePool(old, 'gemini-4-argon')).toBe('argon')
  expect(agyBlockedUntil(old, 'gemini-4-argon')).toBe(Date.parse('2026-12-01T00:00:00Z'))
  expect(agyBlockedUntil(old, 'gemini-4-hydrogen')).toBeUndefined()
})

test('model levels, retirement and alternates follow the model registry', async () => {
  const before = Date.parse('2026-11-29T23:59:59Z')
  const after = Date.parse('2026-11-30T00:00:00Z')
  expect(agyModelId('gemini-4-neon', 'xhigh')).toBe('gemini-4-neon-xhigh')
  expect(agyModelId('gemini-4-carbon', 'max')).toBe('gemini-4-carbon-high')
  expect(agyCurrentModel('gemini-4-argon', before)).toBe('gemini-4-argon')
  expect(agyCurrentModel('gemini-4-argon', after)).toBe('gemini-4-neon')
  expect(agyCurrentModel('gemini-3.8-flash', after)).toBe('gemini-4-hydrogen')
  expect(agyCurrentModel('gpt-oss-120b', after)).toBe('claude-sonnet-5-5')
  for (const model of Object.keys(AGY_MODELS)) for (const alternate of modelAlternates('agy', model, after)) {
    expect(usagePoolOf('agy', alternate) === usagePoolOf('agy', model)).toBe(false)
    expect(agyCurrentModel(alternate, after)).toBe(alternate)
  }
  expect(isModelFor('codex', 'gpt-6-astra')).toBe(true)
  expect(isModelFor('codex', 'gpt-oss-120b')).toBe(false)
  expect(isModelFor('agy', 'gpt-oss-120b')).toBe(true)
  expect(isModelFor('agy', 'gemini-pro-orchestrator')).toBe(false)
})

test('the Antigravity Lead policy names its own server and tools, and none of Claude Code\'s', () => {
  const policy = AGY_LEAD_POLICY(['commandcode', 'codex', 'agy'])
  expect(policy).toContain('`hydra_heads` MCP server')
  expect(policy).toContain('Antigravity runs every `head` and `hunt` call in the background')
  expect(policy).toContain('Send Heads to the other engines first')
  expect(policy).not.toContain('mcp__hydra__')
  expect(policy).not.toContain('background: true')
  expect(policy).toContain('gemini-4-neon')
})
