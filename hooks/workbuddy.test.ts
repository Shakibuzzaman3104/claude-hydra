/**
 * @author Shakib
 * @since 15/10/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import {
  ACCOUNT_SUPPORT, CONSENT_QUESTION, ENGINE_BIN, ENGINE_LABEL, ENGINE_MODEL, HYDRA_POLICY, INSTALL_HINT, PROVIDER, ROUTES, WINDOWS_ENGINES, WORKBUDDY_LOGIN, WORKBUDDY_NO_PRODUCT,
  WORKBUDDY_NO_SPEND, WORKBUDDY_SIGNED_OUT, accountEnv, engineChecks, formatReport, headModelFor, isNoSpend, modelFor, setupCard, workbuddyEnv,
} from './register'

test('runs the CodeBuddy CLI in its own WorkBuddy folder, with the app\'s product file and the extras off', async () => {
  expect(ENGINE_BIN.workbuddy).toBe('codebuddy')
  expect(ENGINE_LABEL.workbuddy).toBe('WorkBuddy')
  expect(workbuddyEnv('/home/me')).toEqual({
    CODEBUDDY_CONFIG_DIR: '/home/me/.claude/hydra/workbuddy-cli',
    ACC_PRODUCT_CONFIG_PATH: '/home/me/.workbuddy-ai/cache/acc-product-config-v3.json',
    CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
    CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: '1',
    CODEBUDDY_PROMPT_SUGGESTION_DISABLED: '1',
    CODEBUDDY_DISABLE_CRON: '1',
    CODEBUDDY_DISABLE_IDE: '1',
    CODEBUDDY_DISABLE_BROWSER_MCP: '1',
  })
})

test('an extra WorkBuddy account moves only the config folder; the product file stays the app\'s', async () => {
  const dir = '/home/me/.claude/hydra/accounts/workbuddy/work'
  const account = accountEnv({ engine: 'workbuddy', name: 'work', dir })
  expect(account).toEqual({ CODEBUDDY_CONFIG_DIR: dir })
  // What startHead runs with: the WorkBuddy env, then the account's folder over it.
  expect({ ...workbuddyEnv('/home/me'), ...account }).toMatchObject({ CODEBUDDY_CONFIG_DIR: dir, ACC_PRODUCT_CONFIG_PATH: '/home/me/.workbuddy-ai/cache/acc-product-config-v3.json' })
  expect(ACCOUNT_SUPPORT.workbuddy!.login(dir, 'darwin')).toBe(`CODEBUDDY_CONFIG_DIR="${dir}" ACC_PRODUCT_CONFIG_PATH="$HOME/.workbuddy-ai/cache/acc-product-config-v3.json" codebuddy`)
  expect(ACCOUNT_SUPPORT.workbuddy!.hint).toContain('/login')
})

test('runs WorkBuddy on DeepSeek V4.1 Flash, without the provider prefix', async () => {
  expect(ENGINE_MODEL.workbuddy).toBe('deepseek-v4.1-flash')
  expect(modelFor('workbuddy', 'deepseek/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
  expect(headModelFor('workbuddy', undefined, 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash')
  expect(headModelFor('workbuddy', undefined, 'gpt-6.1-sol', 'deepseek/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
})

/** A `$` whose file system holds `files` (path → entry names) and nothing else. */
const withFiles = (files: Record<string, string[]>) => ({
  env: { get: async () => undefined },
  process: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
  fs: { exists: async (path: string) => path in files, list: async (path: string) => (files[path] ? files[path]!.map(name => ({ name, kind: 'file', mtimeMs: 0 })) : Promise.reject(new Error('ENOENT'))) },
}) as unknown as EngineInterface

test('says to open the WorkBuddy app, then to sign in, before a WorkBuddy Head can start', async () => {
  const product = '/home/me/.workbuddy-ai/cache/acc-product-config-v3.json'
  const login = '/home/me/.claude/hydra/workbuddy-cli/local_storage'
  expect(await engineChecks(withFiles({}), 'workbuddy', '/home/me')).toEqual({ problems: [WORKBUDDY_NO_PRODUCT], warnings: [] })
  expect(WORKBUDDY_NO_PRODUCT).toBe('Install the WorkBuddy app and sign in once; it creates ~/.workbuddy-ai/cache/acc-product-config-v3.json.')
  expect(await engineChecks(withFiles({ [product]: [] }), 'workbuddy', '/home/me')).toEqual({ problems: [WORKBUDDY_SIGNED_OUT], warnings: [] })
  expect(await engineChecks(withFiles({ [product]: [], [login]: [] }), 'workbuddy', '/home/me')).toEqual({ problems: [WORKBUDDY_SIGNED_OUT], warnings: [] })
  expect(await engineChecks(withFiles({ [product]: [], [login]: ['entry_1.info'] }), 'workbuddy', '/home/me')).toEqual({ problems: [], warnings: [] })
  expect(WORKBUDDY_LOGIN).toBe('CODEBUDDY_CONFIG_DIR=~/.claude/hydra/workbuddy-cli ACC_PRODUCT_CONFIG_PATH=~/.workbuddy-ai/cache/acc-product-config-v3.json codebuddy')
  expect(WORKBUDDY_SIGNED_OUT).toContain('/login')
  expect(INSTALL_HINT.workbuddy).toContain('npm i -g @tencent-ai/codebuddy-code')
  expect(setupCard([{ engine: 'workbuddy', problem: INSTALL_HINT.workbuddy }])).toContain('WorkBuddy: WorkBuddy Heads run it')
})

test('tells the person and the Lead WorkBuddy is CodeBuddy on their WorkBuddy plan, counted in tokens', async () => {
  expect(CONSENT_QUESTION('deepseek-v4.1-flash', 'workbuddy')).toContain('through WorkBuddy')
  expect(PROVIDER.workbuddy).toBe('DeepSeek (via WorkBuddy)')
  expect(ROUTES.workbuddy).toContain('same DeepSeek model through your WorkBuddy subscription (credits)')
  const policy = HYDRA_POLICY('deepseek-v4.1-flash', 'auto', 'workbuddy')
  expect(policy).toContain('WorkBuddy agents on deepseek-v4.1-flash')
  expect(policy).toContain("CodeBuddy's headless mode")
  expect(isNoSpend(WORKBUDDY_NO_SPEND)).toBe(true)
  expect(WINDOWS_ENGINES.has('workbuddy')).toBe(false)
  const report = formatReport({ id: 'h', model: 'deepseek-v4.1-flash', cwd: '/r', sessionId: 's1', finished: true, rounds: 1, turns: 1, usd: null, files: [], denied: [], finalText: '', exit: '0', engine: 'workbuddy', tokens: '1k in / 10 out' })
  expect(report).toContain('codebuddy --resume s1')
  expect(report).toContain('1k in / 10 out')
})
