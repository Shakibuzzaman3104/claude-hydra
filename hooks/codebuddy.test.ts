/**
 * @author Shakib
 * @since 19/11/26
 */
import { expect, test } from 'claude-code/testing'

import { buddySettings, buddyTokensText, foldBuddyRow, newBuddyState } from './engines/codebuddy'

test('allows Glob and Grep in every granted read folder, keeping .env and .hydraignore denied', async () => {
  const settings = buddySettings('/work/app', { addDirs: ['/refs'], shell: false, guarded: { paths: ['/refs/secrets/**'], folders: [], ignoreFiles: [] } })
  const { allow, deny } = settings.permissions
  expect(allow).toEqual(expect.arrayContaining(['Read(/refs/**)', 'Glob(/refs/**)', 'Grep(/refs/**)']))
  expect(deny).toEqual(expect.arrayContaining([
    'Read(/refs/**/.env)', 'Read(/refs/**/.env.*)', 'Glob(/refs/**/.env)', 'Glob(/refs/**/.env.*)', 'Grep(/refs/**/.env)', 'Grep(/refs/**/.env.*)',
    'Read(/refs/secrets/**)', 'Edit(/work/app/**/.hydraignore)',
  ]))
})

test('counts only a resumed run\'s own turns, not the whole session total on the result row', async () => {
  const state = newBuddyState()
  const turn = (id: string, usage: Record<string, number>) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'working' }], usage } })
  foldBuddyRow(turn('m1', { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 50, output_tokens: 10 }), state)
  // The same message read twice is still one turn's usage.
  foldBuddyRow(turn('m1', { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 50, output_tokens: 10 }), state)
  foldBuddyRow(turn('m2', { input_tokens: 30, output_tokens: 4 }), state)
  // A resumed session's result row repeats every earlier turn: it must not be added on top.
  foldBuddyRow({ type: 'result', usage: { input_tokens: 6_864_000, output_tokens: 38_000 } }, state)
  expect(state.inputTokens).toBe(100 + 20 + 50 + 30)
  expect(state.cachedInputTokens).toBe(50)
  expect(state.outputTokens).toBe(10 + 4)
})

test('falls back to the result row\'s usage when no message carried any', async () => {
  const state = newBuddyState()
  foldBuddyRow({ type: 'result', usage: { input_tokens: 400, cache_read_input_tokens: 100, output_tokens: 20 } }, state)
  expect(state.inputTokens).toBe(500)
  expect(state.cachedInputTokens).toBe(100)
  expect(state.outputTokens).toBe(20)
})

test('names cached input apart in the token line, and leaves it out when there is none', async () => {
  expect(buddyTokensText(20_410_000, 19_800_000, 64_000)).toBe('20410k in (19800k cached) / 64k out')
  expect(buddyTokensText(20_410_000, 0, 64_000)).toBe('20410k in / 64k out')
  expect(buddyTokensText(91530, 421, 421)).toBe('92k in (421 cached) / 421 out')
})
