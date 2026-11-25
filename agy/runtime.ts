/**
 * @author Shakib
 * @since 25/11/26
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, resolve } from 'node:path'

const RUN_DEFAULT_MS = 30_000
const RUN_MAX_MS = 600_000

export type Ask = (question: string, options: { options: string[]; header?: string }) => Promise<string | undefined>

export type RuntimeOptions = {
  dataDir: string
  pluginRoot: string
  workspace: string
  sessionId: () => string
  ask: Ask
}

/** A JSON object kept in one file, written whole through a temp file so a crash never leaves half of it. */
export class JsonFile {
  private values: Record<string, unknown>

  constructor(private readonly path: string) {
    this.values = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8') || '{}') : {}
  }

  has = (key: string) => Object.prototype.hasOwnProperty.call(this.values, key)
  get = (key: string) => this.values[key]
  keys = () => Object.keys(this.values)

  set(key: string, value: unknown) {
    this.values[key] = value
    this.save()
  }

  delete(key: string) {
    delete this.values[key]
    this.save()
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.values))
    renameSync(temp, this.path)
  }
}

const kindOf = (entry: Dirent | { isFile(): boolean; isDirectory(): boolean }) => (entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other')

const runProcess = (argv: string[], init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string } = {}) =>
  new Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }>((done, fail) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...(init.env ?? {}) } })
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

const spawnProcess = (request: { argv: string[]; cwd?: string; env?: Record<string, string>; input?: string }) => {
  const child = spawn(request.argv[0]!, request.argv.slice(1), { cwd: request.cwd, env: { ...process.env, ...(request.env ?? {}) } })
  const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = []
  let wake: (() => void) | undefined
  let isClosed = false
  const push = (chunk: { stream: 'stdout' | 'stderr'; text: string }) => {
    chunks.push(chunk)
    wake?.()
  }
  const result = new Promise<{ code: number | null; signal?: string }>((done, fail) => {
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
        await new Promise<void>(resume => (wake = resume))
      }
    },
    async return(value: unknown) {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3_000).unref()
      return { done: true, value }
    },
  }
}

/** The part of Claude Code's plugin interface Hydra's engines use, backed by Node and files under `dataDir`. */
export function createRuntime(options: RuntimeOptions) {
  const store = new JsonFile(resolve(options.dataDir, 'store.json'))
  const states = new Map<string, JsonFile>()
  const stateOf = () => {
    const id = options.sessionId()
    let file = states.get(id)
    if (!file) states.set(id, (file = new JsonFile(resolve(options.dataDir, 'sessions', id.replace(/[^\w.-]/g, '_'), 'state.json'))))
    return file
  }
  return {
    state: { has: (key: string) => stateOf().has(key), get: (key: string) => stateOf().get(key), set: (key: string, value: unknown) => stateOf().set(key, value) },
    plugin: { root: options.pluginRoot },
    session: { id: async () => options.sessionId(), root: async () => options.workspace, surfaces: async () => [] },
    env: { get: async (name: string) => process.env[name] },
    clock: {
      now: async () => Date.now(),
      sleep: (ms: number, sleepOptions: { signal?: AbortSignal } = {}) =>
        new Promise<void>((done, fail) => {
          const timer = setTimeout(done, ms)
          sleepOptions.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            fail(new Error('aborted'))
          }, { once: true })
        }),
    },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => store.set(key, value),
      delete: async (key: string) => store.delete(key),
      keys: async () => store.keys(),
    },
    ui: {
      ask: (question: string, askOptions: { options: string[]; header?: string }) => options.ask(question, askOptions),
      toast: () => undefined,
      status: () => undefined,
      log: () => undefined,
      invalidate: () => undefined,
      resolve: async () => undefined,
    },
    fs: {
      exists: async (path: string) => existsSync(path),
      read: async (path: string, readOptions?: { as?: string }) => (readOptions?.as === 'bytes' ? { base64: (await readFile(path)).toString('base64') } : readFile(path, 'utf8')),
      write: async (path: string, text: string) => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
      },
      list: async (path: string = options.workspace) =>
        Promise.all((await readdir(path, { withFileTypes: true })).map(async entry => {
          const own = entry.isFile() ? await lstat(resolve(path, entry.name)) : undefined
          return { name: entry.name, kind: kindOf(entry), size: own?.size ?? 0, mtimeMs: own?.mtimeMs ?? 0, isLink: entry.isSymbolicLink() }
        })),
      stat: async (path: string, statOptions?: { resolve?: boolean }) => {
        const [own, target] = [await lstat(path), await stat(path)]
        return { kind: kindOf(target), size: target.size, mtimeMs: target.mtimeMs, isLink: own.isSymbolicLink(), ...(statOptions?.resolve ? { realPath: await realpath(path) } : {}) }
      },
    },
    process: { run: runProcess, spawn: spawnProcess },
  }
}
