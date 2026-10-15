/**
 * @author Shakib
 * @since 15/10/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import {
  ACCOUNT_SUPPORT, AUTO_CONSENT_QUESTION, CONSENT_QUESTION, ENGINE_MODEL, HYDRA_POLICY, INSTALL_HINT, OPENCODE_DENY, OPENCODE_MODEL, OPENCODE_NO_LOGIN, OPENCODE_WATCHDOG, OPENCODE_WEAKER,
  ROUTES, SECRET_PATHS, WINDOWS_ENGINES, engineChecks, foldOpenCodeRow, formatReport, headModelFor, isModelFor, isQuotaFailure, majorOf, modelFor, newOpenCodeState, opencodeArgs,
  opencodeConfig, opencodeEnv, patchFiles, silenceLeft, withEnv,
} from './register'
import type { OpenCodeRow } from './register'

const CWD = '/home/me/app'

/** Real lines from `opencode run --format json` (v2.0.18, 15/10/26), shortened. */
const LINES = {
  start: '{"type":"step_start","timestamp":1792055020000,"sessionID":"ses_ec1327db9ffe2Sod0U5UdXLhFx","part":{"id":"prt_1","sessionID":"ses_ec1327db9ffe2Sod0U5UdXLhFx","messageID":"msg_1","type":"step-start","snapshot":"e8df0e94"}}',
  text: '{"type":"text","timestamp":1792055020100,"sessionID":"ses_ec1327db9ffe2Sod0U5UdXLhFx","part":{"id":"prt_2","messageID":"msg_1","type":"text","text":"**Step 2:**","time":{"start":1,"end":2}}}',
  wrote: '{"type":"tool_use","timestamp":1792055023825,"sessionID":"ses_ec1327db9ffe2Sod0U5UdXLhFx","part":{"partID":"prt_3","messageID":"msg_1","type":"tool","id":"call_00_nidchaap49skwgs03war5ugf","tool":"write","state":{"status":"completed","input":{"path":"b.txt","content":"new file"},"output":"Wrote file successfully: b.txt","title":"write"}}}',
  refused: '{"type":"tool_use","timestamp":1792055031684,"sessionID":"ses_ec1327db9ffe2Sod0U5UdXLhFx","part":{"partID":"prt_4","messageID":"msg_2","type":"tool","id":"call_00_029zvr9rz4fejagz2w38oehv","tool":"write","state":{"status":"error","input":{"content":"escape","path":"../sibling/x.txt"},"error":"Permission denied: external_directory"}}}',
  envRead: '{"type":"tool_use","timestamp":1792055031700,"sessionID":"ses_ec1327db9ffe2Sod0U5UdXLhFx","part":{"type":"tool","id":"call_5","tool":"read","state":{"status":"error","input":{"path":".env"},"error":"Permission denied: read"}}}',
  finish: '{"type":"step_finish","timestamp":1792055021141,"sessionID":"ses_ec1327db9ffe2Sod0U5UdXLhFx","part":{"id":"prt_6","type":"step-finish","reason":"tool-calls","cost":0.0012,"tokens":{"input":2340,"output":104,"reasoning":82,"cache":{"read":100,"write":10}}}}',
  quota: '{"type":"error","timestamp":1792055040000,"sessionID":"ses_ec1327db9ffe2Sod0U5UdXLhFx","error":{"type":"provider.quota","message":"Quota exceeded for this key","status":429}}',
}
const rowOf = (line: string) => JSON.parse(line) as OpenCodeRow

test('builds the OpenCode command: a private server, JSON events, the model, a session to resume, the prompt after --', async () => {
  expect(opencodeArgs({ prompt: '-do it', model: OPENCODE_MODEL })).toEqual(['opencode', 'run', '--standalone', '--format', 'json', '-m', OPENCODE_MODEL, '--', '-do it'])
  expect(opencodeArgs({ prompt: 'go on', model: 'openrouter/x', resume: 'ses_1' })).toEqual(['opencode', 'run', '--standalone', '--format', 'json', '-m', 'openrouter/x', '-s', 'ses_1', '--', 'go on'])
  expect(opencodeArgs({ prompt: 'p', model: 'm' })).not.toContain('--auto')
})

test('denies everything by default and every risky tool by name, and never leaves a rule at ask', async () => {
  const config = opencodeConfig(CWD, { addDirs: [], writeDirs: [], shell: false }, [], '/home/me')
  expect(Object.keys(config.permission)[0]).toBe('*')
  expect(config.permission['*']).toBe('deny')
  for (const key of ['shell', 'bash', 'grep', 'execute', 'webfetch', 'websearch', 'task', 'subagent', 'question', 'skill', 'lsp', 'doom_loop']) {
    expect((config.permission as Record<string, unknown>)[key]).toBe('deny')
    expect((config.tools as Record<string, boolean>)[key]).toBe(false)
  }
  for (const key of OPENCODE_DENY) expect((config.permission as Record<string, unknown>)[key]).toBe('deny')
  expect(JSON.stringify(config)).not.toContain('"ask"')
  expect(config.permission.external_directory).toEqual({ '*': 'deny' })
  expect(config.permission.todowrite).toBe('allow')
  expect(config.share).toBe('disabled')
  expect(config.autoupdate).toBe(false)
})

test('reads the project but no .env file, edits it but never .git or .env', async () => {
  const { permission } = opencodeConfig(CWD, { addDirs: [], writeDirs: [], shell: false })
  expect(permission.read).toEqual({ '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' })
  expect(permission.edit).toMatchObject({ '*': 'allow', '.git': 'deny', '.git/*': 'deny', '*/.git': 'deny', '*/.git/*': 'deny', '*.env': 'deny', '*.env.*': 'deny' })
  // Rules match in order with the last one winning, so the allow comes first and every deny after it.
  expect(Object.keys(permission.read)[0]).toBe('*')
  expect(Object.keys(permission.edit)[0]).toBe('*')
})

test('ignores shell: an OpenCode Head never gets one', async () => {
  const head = { addDirs: [], writeDirs: [] }
  expect(opencodeConfig(CWD, { ...head, shell: true })).toEqual(opencodeConfig(CWD, { ...head, shell: false }))
  const policy = HYDRA_POLICY(OPENCODE_MODEL, 'auto', 'opencode')
  expect(policy).toContain('NEVER have a shell')
  expect(policy).toContain('`shell: true` is ignored')
  expect(policy).toContain('BETA')
})

test('opens writeDirs and addDirs outside the project, denies edits to a folder it may only read, and closes credential folders', async () => {
  const { permission } = opencodeConfig(CWD, { addDirs: ['/home/me/specs', `${CWD}/docs`], writeDirs: ['/home/me/lib/'], shell: false }, [], '/home/me')
  expect(permission.external_directory).toEqual({ '*': 'deny', '/home/me/lib/*': 'allow', '/home/me/specs/*': 'allow' })
  expect(permission.edit).toMatchObject({ '/home/me/specs': 'deny', '/home/me/specs/*': 'deny' })
  expect(permission.edit).not.toHaveProperty('/home/me/lib/*')
  for (const secret of SECRET_PATHS) {
    for (const rules of [permission.read, permission.edit, permission.glob]) {
      expect(rules).toHaveProperty([`/home/me/${secret}`], 'deny')
      expect(rules).toHaveProperty([`/home/me/${secret}/*`], 'deny')
    }
  }
})

test('denies a symlink that leads out of the project, unless it leads into a granted folder', async () => {
  const links = [{ path: 'link-out', target: '/home/me/sibling' }, { path: 'lib', target: '/home/me/lib/src' }, { path: 'spec', target: '/home/me/specs' }]
  const { permission } = opencodeConfig(CWD, { addDirs: ['/home/me/specs'], writeDirs: ['/home/me/lib'], shell: false }, links)
  expect(permission.edit).toMatchObject({ 'link-out': 'deny', 'link-out/*': 'deny', spec: 'deny', 'spec/*': 'deny' })
  expect(permission.edit).not.toHaveProperty('lib/*')
  expect(permission.read).toMatchObject({ 'link-out': 'deny', 'link-out/*': 'deny' })
  expect(permission.read).not.toHaveProperty('spec/*')
  expect(permission.read).not.toHaveProperty('lib/*')
})

test('runs each Head with its own config, no project config and its own config home', async () => {
  const env = opencodeEnv('/h/.claude/hydra/heads/opencode-s-h.json', '/h/.claude/hydra/heads/opencode-s-h', '{"x":1}')
  expect(env).toEqual({
    OPENCODE_CONFIG: '/h/.claude/hydra/heads/opencode-s-h.json', OPENCODE_CONFIG_CONTENT: '{"x":1}', OPENCODE_CONFIG_DIR: '/h/.claude/hydra/heads/opencode-s-h',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', XDG_CONFIG_HOME: '/h/.claude/hydra/heads/opencode-s-h',
  })
  expect(env).not.toHaveProperty('XDG_DATA_HOME')
  // An extra account moves only the data folder (its sign-ins); the config home stays the Head's own.
  const account = ACCOUNT_SUPPORT.opencode!.env!('/h/.claude/hydra/accounts/opencode/work')
  expect(opencodeEnv('/c.json', '/c', '{}', account)).toMatchObject({ XDG_DATA_HOME: '/h/.claude/hydra/accounts/opencode/work/data', XDG_CONFIG_HOME: '/c' })
  expect(ACCOUNT_SUPPORT.opencode!.login('/a', 'darwin')).toBe('XDG_DATA_HOME="/a/data" opencode auth login')
  expect(withEnv('windows', { XDG_DATA_HOME: '/a/data' }, 'opencode auth login')).toBe('$env:XDG_DATA_HOME="/a/data"; opencode auth login')
})

test('folds the event stream: a turn per step, files from writes, refusals, tokens and cost, the session id', async () => {
  const state = newOpenCodeState(CWD)
  const events = [LINES.start, LINES.text, LINES.wrote, LINES.refused, LINES.envRead, LINES.finish].flatMap(line => foldOpenCodeRow(rowOf(line), state))
  expect(state.sessionId).toBe('ses_ec1327db9ffe2Sod0U5UdXLhFx')
  expect(state.turns).toBe(1)
  expect(events.filter(event => event.type === 'turn_end')).toHaveLength(1)
  expect([...state.files]).toEqual([`${CWD}/b.txt`])
  expect(state.denied).toEqual([
    { tool: 'write_file', target: `${CWD}/../sibling/x.txt`, text: 'Permission denied: external_directory' },
    { tool: 'read_file', target: `${CWD}/.env`, text: 'Permission denied: read' },
  ])
  expect(events.filter(event => event.type === 'tool_denied')).toHaveLength(2)
  expect(events.find(event => event.type === 'tool_completed')).toMatchObject({ toolName: 'write_file', isError: false })
  expect(events.find(event => event.type === 'tool_queued')).toMatchObject({ toolName: 'write_file', input: { path: `${CWD}/b.txt` } })
  expect(state.inputTokens).toBe(2340 + 100 + 10)
  expect(state.outputTokens).toBe(104 + 82)
  expect(Math.round(state.usd * 10_000)).toBe(12)
  expect(state.finalText).toBe('**Step 2:**')
})

test('keeps the last step\'s text as the report, joining the parts of one step', async () => {
  const state = newOpenCodeState(CWD)
  const text = (value: string) => ({ type: 'text', sessionID: 's', part: { type: 'text', text: value } })
  for (const row of [{ type: 'step_start' }, text('working'), { type: 'step_start' }, text('done.'), text('HEAD DONE')]) foldOpenCodeRow(row, state)
  expect(state.finalText).toBe('done.\nHEAD DONE')
})

test('reads the files a patch names, and flags a tool that should have been refused', async () => {
  expect(patchFiles('*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: b.ts\n*** Move to: c.ts\n*** End Patch')).toEqual(['src/a.ts', 'b.ts', 'c.ts'])
  const state = newOpenCodeState(CWD)
  foldOpenCodeRow({ type: 'tool_use', part: { id: 'c1', tool: 'apply_patch', state: { status: 'completed', input: { patchText: '*** Update File: src/a.ts\n' } } } }, state)
  foldOpenCodeRow({ type: 'tool_use', part: { id: 'c2', tool: 'execute', state: { status: 'completed', input: { code: '1+1' } } } }, state)
  foldOpenCodeRow({ type: 'tool_use', part: { id: 'c3', tool: 'shell', state: { status: 'error', input: { command: 'curl x' }, error: 'Permission denied: shell' } } }, state)
  expect([...state.files]).toEqual([`${CWD}/src/a.ts`])
  expect(state.flagged).toEqual(["the Head ran OpenCode's `execute` tool, which Hydra's rules deny: check what it did"])
  expect(state.denied).toEqual([{ tool: 'shell_command', target: 'curl x', text: 'Permission denied: shell' }])
  const report = formatReport({ id: 'h', model: OPENCODE_MODEL, cwd: CWD, sessionId: 'ses_1', finished: true, rounds: 1, turns: 2, usd: null, files: [], denied: [], finalText: 'HEAD DONE', exit: '0', engine: 'opencode', warnings: state.flagged })
  expect(report).toContain('⚠ the Head ran OpenCode\'s `execute` tool')
  expect(report).toContain('(opencode run -s ses_1)')
})

test('surfaces usage-limit errors so the account switch sees them', async () => {
  const state = newOpenCodeState(CWD)
  foldOpenCodeRow(rowOf(LINES.quota), state)
  expect(state.failures).toEqual(['provider.quota: Quota exceeded for this key'])
  expect(isQuotaFailure('provider.rate-limit: slow down')).toBe(true)
  expect(isQuotaFailure('provider.quota: x')).toBe(true)
  expect(isQuotaFailure("You've hit your usage limit. Upgrade to Plus")).toBe(true)
  expect(isQuotaFailure('400 insufficient credits')).toBe(true)
  expect(isQuotaFailure('PREMIUM_CREDITS_EXHAUSTED: buy more')).toBe(true)
  expect(isQuotaFailure('provider.auth: 403 free tier can only be used from within OpenCode')).toBe(false)
  expect(isQuotaFailure('provider.no-route: Model unavailable: opencode/nope-free')).toBe(false)
})

test('stops a silent OpenCode run: 90 s before its first output, 5 min between outputs', async () => {
  expect(OPENCODE_WATCHDOG).toEqual({ firstMs: 90_000, idleMs: 300_000 })
  expect(silenceLeft(OPENCODE_WATCHDOG, 1_000, undefined, 1_000)).toBe(90_000)
  expect(silenceLeft(OPENCODE_WATCHDOG, 1_000, undefined, 91_000)).toBe(0)
  expect(silenceLeft(OPENCODE_WATCHDOG, 1_000, 50_000, 60_000)).toBe(290_000)
  expect(silenceLeft(OPENCODE_WATCHDOG, 1_000, 50_000, 999_000)).toBe(0)
  expect(silenceLeft({}, 1_000, undefined, 5_000)).toBeUndefined()
  expect(silenceLeft({ firstMs: 10 }, 0, 3, 5)).toBeUndefined()
})

test('runs OpenCode models with their provider prefix, and defaults to the free DeepSeek one', async () => {
  expect(ENGINE_MODEL.opencode).toBe('opencode/deepseek-v4.1-flash-free')
  expect(modelFor('opencode', 'openrouter/qwen/qwen3-coder')).toBe('openrouter/qwen/qwen3-coder')
  expect(isModelFor('opencode', 'opencode/big-pickle')).toBe(true)
  expect(isModelFor('opencode', 'openrouter/anthropic/claude-sonnet-5')).toBe(true)
  expect(isModelFor('opencode', 'deepseek/deepseek-v4.1-flash')).toBe(false)
  expect(isModelFor('opencode', 'deepseek-v4.1-flash')).toBe(false)
  // Command Code's model is not an OpenCode one, and OpenCode's own models are no other engine's.
  expect(headModelFor('opencode', undefined, 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash')).toBe(OPENCODE_MODEL)
  expect(headModelFor('commandcode', undefined, OPENCODE_MODEL, 'deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash')
  expect(isModelFor('codebuddy', OPENCODE_MODEL)).toBe(false)
  expect(isModelFor('commandcode', 'moonshotai/kimi-k3')).toBe(true)
})

test('tells the person and the Lead that OpenCode is beta with a weaker lockdown', async () => {
  expect(CONSENT_QUESTION(OPENCODE_MODEL, 'opencode')).toContain("OpenCode Heads are locked down by OpenCode's own permission rules only (no OS sandbox), so the lockdown is weaker than the other engines'.")
  expect(AUTO_CONSENT_QUESTION(['codex', 'opencode'])).toContain(OPENCODE_WEAKER)
  expect(AUTO_CONSENT_QUESTION(['codex', 'agy'])).not.toContain(OPENCODE_WEAKER)
  expect(ROUTES.opencode).toContain('BETA')
  expect(ROUTES.opencode).toContain('name the exact files')
  const auto = HYDRA_POLICY('m', 'auto', 'auto', ['codex', 'opencode'])
  expect(auto).toContain('`opencode` (OpenCode)')
  expect(auto).toContain('no write guard')
  expect(HYDRA_POLICY(OPENCODE_MODEL, 'auto', 'opencode')).toContain('`effort` is ignored')
  expect(WINDOWS_ENGINES.has('opencode')).toBe(false)
  expect(INSTALL_HINT.opencode).toContain('curl -fsSL https://opencode.ai/install | bash')
  expect(INSTALL_HINT.opencode).toContain('npm i -g opencode-ai')
})

/** A `$` whose processes answer from `replies` (by argv joined with spaces) and whose files are `files`. */
const fakeShell = (replies: Record<string, { exitCode: number; stdout: string }>, files: Record<string, string[]> = {}) => {
  const ran: string[] = []
  const $ = {
    env: { get: async () => undefined },
    process: { run: async (argv: string[]) => {
      ran.push(argv.join(' '))
      return { stderr: '', ...(replies[argv.join(' ')] ?? { exitCode: 1, stdout: '' }) }
    } },
    fs: { exists: async (path: string) => path in files, list: async (path: string) => (files[path] ?? []).map(name => ({ name, kind: 'file', mtimeMs: 0 })) },
  } as unknown as EngineInterface
  return { $, ran }
}

test('checks OpenCode\'s version and providers without starting its background service', async () => {
  expect(majorOf('opencode v2.0.18\n')).toBe(2)
  expect(majorOf('1.4.2')).toBe(1)
  expect(majorOf('nothing')).toBeUndefined()
  const ready = fakeShell({ 'opencode --version': { exitCode: 0, stdout: 'opencode v2.0.18' }, 'opencode auth list --standalone': { exitCode: 0, stdout: 'OpenRouter  OPENROUTER_API_KEY  environment' } })
  expect(await engineChecks(ready.$, 'opencode', '/home/me')).toEqual({ problems: [], warnings: [] })
  expect(ready.ran).toContain('opencode auth list --standalone')
  const old = fakeShell({ 'opencode --version': { exitCode: 0, stdout: '1.4.2' }, 'opencode auth list --standalone': { exitCode: 0, stdout: '' } })
  const checked = await engineChecks(old.$, 'opencode', '/home/me')
  expect(checked.problems).toEqual([])
  expect(checked.warnings[0]).toContain('older than v2')
  expect(checked.warnings[1]).toBe(OPENCODE_NO_LOGIN)
})
