/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

/**
 * Where Hydra runs. Heads are started by argument vector (no shell): `$.process.spawn` closes stdin when it is given
 * no input and sets `env` over the host's own, so nothing here needs `/bin/sh` or `/usr/bin/env`, and the same
 * command line works on macOS, Linux and Windows once the executable is found.
 */
export type Platform = 'darwin' | 'linux' | 'windows'

let detected: Platform | undefined

export async function platformOf($: EngineInterface): Promise<Platform> {
  if (detected) return detected
  if ((await $.env.get('OS')) === 'Windows_NT') return (detected = 'windows')
  const ran = await $.process.run(['uname', '-s'], { timeoutMs: 10_000 }).catch(() => undefined)
  detected = ran?.stdout.trim() === 'Darwin' ? 'darwin' : 'linux'
  return detected
}

/** Forgets the platform read for this process: a test runs the same code as macOS and as Linux. */
export const resetPlatform = () => {
  detected = undefined
}

/** The person's home folder: `HOME`, or `USERPROFILE` on Windows where `HOME` is usually unset. Always with forward slashes. */
export async function homeOf($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  return toSlashes(home)
}

/** `C:\Users\me\app` → `C:/Users/me/app`; POSIX paths are unchanged. Hydra compares and writes rules with forward slashes. */
export const toSlashes = (path: string) => path.replace(/\\/g, '/')

/** A Windows drive path (`C:/…`, `C:\…`) or UNC path (`//server/share`, `\\server\share`). */
export const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || /^(\\\\|\/\/)[^\\/]/.test(path)

/**
 * The script an npm `.cmd` shim runs, relative to the shim's folder. npm writes shims like
 * `"%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`; running that script with `node` directly avoids
 * `cmd.exe`, its 8,191-character command line and its quoting rules, which a Head's prompt would trip over.
 */
export const shimTarget = (shim: string) => {
  const found = /"%~?dp0%?\\([^"]+?\.(?:js|cjs|mjs))"/i.exec(shim)
  return found ? found[1]!.replace(/\\/g, '/') : undefined
}

/** The folder of a Windows path, keeping forward slashes. */
export const dirOf = (path: string) => toSlashes(path).replace(/\/[^/]*$/, '')

const resolved = new Map<string, readonly string[]>()

/**
 * The argument vector that starts a CLI found on `PATH`. On macOS and Linux that is the bare name (the host resolves
 * it). On Windows an `.exe` runs as is and an npm `.cmd` shim runs as `node <its script>`; a shim Hydra cannot read
 * falls back to `cmd.exe /d /s /c`, which works for short command lines.
 */
export async function commandOf($: EngineInterface, bin: string): Promise<readonly string[]> {
  if ((await platformOf($)) !== 'windows') return [bin]
  const cached = resolved.get(bin)
  if (cached) return cached
  const where = await $.process.run(['where.exe', bin], { timeoutMs: 10_000 }).catch(() => undefined)
  const paths = (where?.exitCode === 0 ? where.stdout : '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const exe = paths.find(path => /\.exe$/i.test(path))
  const cmd = paths.find(path => /\.cmd$/i.test(path))
  let argv: readonly string[] = [bin]
  if (exe) argv = [exe]
  else if (cmd) {
    const target = shimTarget(await $.fs.read(cmd).catch(() => ''))
    argv = target ? ['node', `${dirOf(cmd)}/${target}`] : ['cmd.exe', '/d', '/s', '/c', cmd]
  }
  if (paths.length > 0) resolved.set(bin, argv)
  return argv
}

/** Whether a CLI starts and answers `--version` (or the given arguments). */
export async function canRun($: EngineInterface, bin: string, args: readonly string[] = ['--version']) {
  const argv = await commandOf($, bin)
  return $.process.run([...argv, ...args], { timeoutMs: 15_000 }).then(ran => ran.exitCode === 0, () => false)
}

let python: readonly string[] | undefined

/** How to start Python 3: `python3` on macOS and Linux; on Windows the `py -3` launcher, else `python`. */
export async function pythonOf($: EngineInterface): Promise<readonly string[] | undefined> {
  if (python) return python
  const candidates: (readonly string[])[] = (await platformOf($)) === 'windows' ? [['py', '-3'], ['python'], ['python3']] : [['python3']]
  for (const argv of candidates) {
    const ran = await $.process.run([...argv, '--version'], { timeoutMs: 10_000 }).catch(() => undefined)
    if (ran?.exitCode === 0 && /Python 3\./.test(ran.stdout + ran.stderr)) return (python = argv)
  }
  return undefined
}

/** Runs one of Hydra's own Python scripts (`bin/<script>`) isolated (`-I`); rejects when Python 3 is missing. */
export async function runScript($: EngineInterface, script: string, args: readonly string[], timeoutMs = 30_000) {
  const python = await pythonOf($)
  if (!python) throw new Error('Python 3 is missing')
  return $.process.run([...python, '-I', `${$.plugin.root}/bin/${script}`, ...args], { timeoutMs })
}
