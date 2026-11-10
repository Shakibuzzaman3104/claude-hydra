/**
 * @author Shakib
 * @since 10/11/26
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const OUT = resolve(ROOT, '.claude/live')
const RUN_DEFAULT_MS = 30_000
const RUN_MAX_MS = 600_000
const HEAD_MODEL = 'deepseek/deepseek-v4.1-flash'

const USAGE = `Runs one real Head outside Claude Code: the engine's own run loop, lockdown, check and report.

  node tests/live/head.mjs --engine codebuddy --cwd <project> --task "<brief>" [options]

  --name <id>          the Head's name (default: live); its session is saved under .claude/live/<id>.json
  --resume <id>        continue the session an earlier run saved under that name
  --model <id>         the Head model (default: the engine's own)
  --check "<command>"  acceptance check, run in cwd
  --max-turns <n>      turn cap
  --minutes <n>        time limit
  --effort <level>     low, medium, high, xhigh or max
  --shell              give the Head a shell
  --file <path>        a file the Head must create or change (repeatable): its progress is measured against these
  --add-dir <path>     a folder the Head may read (repeatable)
  --write-dir <path>   a folder the Head may also write (repeatable)

Keep test projects under the repo's gitignored .claude/ folder, never in /tmp.`

const { values } = parseArgs({
  options: {
    engine: { type: 'string' }, cwd: { type: 'string' }, task: { type: 'string' }, name: { type: 'string', default: 'live' },
    resume: { type: 'string' }, model: { type: 'string' }, check: { type: 'string' }, 'max-turns': { type: 'string' },
    minutes: { type: 'string' }, effort: { type: 'string' }, shell: { type: 'boolean', default: false },
    file: { type: 'string', multiple: true, default: [] }, 'add-dir': { type: 'string', multiple: true, default: [] }, 'write-dir': { type: 'string', multiple: true, default: [] },
    help: { type: 'boolean', default: false },
  },
})

if (values.help || !values.engine || !values.cwd || !values.task) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 2)
}

const bundlePath = resolve(OUT, 'hydra.mjs')

const bundleEngines = () => {
  mkdirSync(OUT, { recursive: true })
  const built = spawnSync('npx', [
    '-y', 'esbuild@0.24.0', resolve(HERE, 'entry.ts'), '--bundle', '--format=esm', '--platform=node', '--log-level=warning',
    `--alias:claude-code=${resolve(HERE, 'claude-code-stub.mjs')}`, `--outfile=${bundlePath}`,
  ], { cwd: ROOT, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

const kindOf = entry => (entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other')

const runProcess = (argv, init = {}) => new Promise((done, fail) => {
  const child = spawn(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...(init.env ?? {}) } })
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    fail(new Error(`timed out: ${argv[0]}`))
  }, Math.min(init.timeoutMs ?? RUN_DEFAULT_MS, RUN_MAX_MS))
  child.stdout.on('data', chunk => (stdout += chunk))
  child.stderr.on('data', chunk => (stderr += chunk))
  child.on('error', error => {
    clearTimeout(timer)
    fail(error)
  })
  child.on('close', code => {
    clearTimeout(timer)
    done({ exitCode: code ?? 1, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(init.stdin ?? '')
})

const spawnProcess = request => {
  const child = spawn(request.argv[0], request.argv.slice(1), { cwd: request.cwd, env: { ...process.env, ...(request.env ?? {}) } })
  const chunks = []
  let wake
  let isClosed = false
  const push = chunk => {
    chunks.push(chunk)
    wake?.()
  }
  const result = new Promise((done, fail) => {
    child.on('error', error => {
      isClosed = true
      wake?.()
      fail(error)
    })
    child.on('close', (code, signal) => {
      isClosed = true
      wake?.()
      done({ code, ...(signal ? { signal } : {}) })
    })
  })
  result.catch(() => undefined)
  child.stdout.on('data', data => push({ stream: 'stdout', text: String(data) }))
  child.stderr.on('data', data => push({ stream: 'stderr', text: String(data) }))
  child.stdin.on('error', () => undefined)
  child.stdin.end(request.input ?? '')
  return {
    result,
    async next() {
      for (;;) {
        if (chunks.length > 0) return { done: false, value: chunks.shift() }
        if (isClosed) return { done: true, value: await result.catch(() => ({ code: null })) }
        await new Promise(resume => (wake = resume))
      }
    },
    async return(value) {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3_000).unref()
      return { done: true, value }
    },
  }
}

const engine = {
  state: new Map(),
  plugin: { root: ROOT },
  session: { id: async () => 'hydra-live', root: async () => resolve(values.cwd) },
  env: { get: async name => process.env[name] },
  clock: {
    now: async () => Date.now(),
    sleep: (ms, options = {}) => new Promise((done, fail) => {
      const timer = setTimeout(done, ms)
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        fail(new Error('aborted'))
      }, { once: true })
    }),
  },
  store: (() => {
    const kept = new Map()
    return { get: async key => kept.get(key), set: async (key, value) => void kept.set(key, value) }
  })(),
  ui: { toast: () => undefined, status: () => undefined, ask: async () => undefined },
  fs: {
    exists: async path => existsSync(path),
    read: async (path, options) => (options?.as === 'bytes' ? { base64: (await readFile(path)).toString('base64') } : readFile(path, 'utf8')),
    write: async (path, text) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    },
    list: async (path = values.cwd) => Promise.all((await readdir(path, { withFileTypes: true })).map(async entry => {
      const own = entry.isFile() ? await lstat(resolve(path, entry.name)) : undefined
      return { name: entry.name, kind: kindOf(entry), size: own?.size ?? 0, mtimeMs: own?.mtimeMs ?? 0, isLink: entry.isSymbolicLink() }
    })),
    stat: async (path, options) => {
      const [own, target] = [await lstat(path), await stat(path)]
      return { kind: kindOf(target), size: target.size, mtimeMs: target.mtimeMs, isLink: own.isSymbolicLink(), ...(options?.resolve ? { realPath: await realpath(path) } : {}) }
    },
  },
  process: { run: runProcess, spawn: spawnProcess },
}

const sessionPath = name => resolve(OUT, `${name}.json`)

const main = async () => {
  bundleEngines()
  const hydra = await import(`${pathToFileURL(bundlePath).href}?at=${Date.now()}`)
  const resumeSession = values.resume ? JSON.parse(readFileSync(sessionPath(values.resume), 'utf8')) : undefined
  const stop = new AbortController()
  process.on('SIGINT', () => stop.abort('stopped by the person'))
  const input = {
    task: values.task, cwd: resolve(values.cwd), addDirs: values['add-dir'].map(dir => resolve(dir)), writeDirs: values['write-dir'].map(dir => resolve(dir)),
    shell: values.shell, ...(values.file.length > 0 ? { files: values.file } : {}), ...(values.check ? { check: values.check } : {}),
    ...(values['max-turns'] ? { maxTurns: Number(values['max-turns']) } : {}), ...(values.minutes ? { maxMinutes: Number(values.minutes) } : {}),
    ...(values.effort ? { effort: values.effort } : {}), ...(resumeSession ? { resumeSession } : {}),
  }
  const targetEngine = resumeSession?.engine ?? values.engine
  const headModel = resumeSession?.model ?? hydra.modelOn(targetEngine, values.model, HEAD_MODEL, HEAD_MODEL)
  const startedAt = Date.now()
  const result = await hydra.runHead(engine, { ...input, model: headModel }, headModel, stop.signal, values.name, targetEngine)
  const run = (await hydra.readRuns(engine)).find(entry => entry.id === values.name)
  if (result.session) writeFileSync(sessionPath(values.name), JSON.stringify(result.session, null, 2))
  console.log(result.text)
  console.log('\n--- live harness ---')
  console.log(JSON.stringify({
    isDone: result.isDone, ending: result.ending, session: result.session, files: result.files,
    run: run && { state: run.state, turns: run.turns, maxTurns: run.maxTurns, activity: run.activity, ending: run.ending, tokens: run.tokens, earlierTurns: run.earlierTurns, expected: run.expected, touched: run.touched, files: run.files, stats: run.stats, check: run.check },
    seconds: Math.round((Date.now() - startedAt) / 1000),
  }, null, 2))
  process.exit(0)
}

await main()
