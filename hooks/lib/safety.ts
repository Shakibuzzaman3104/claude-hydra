/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

export type HeadNeeds = { addDirs: readonly string[]; shell: boolean; writeDirs?: readonly string[] }

export const union = (a: readonly string[] = [], b: readonly string[] = []) => [...new Set([...a, ...b])]

export const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

export const isWithin = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)

/** Shell commands a Head never runs, even when its task turns shell on. */
export const DANGEROUS_SHELL = [
  'Shell(git commit*)', 'Shell(git push*)', 'Shell(git reset*)', 'Shell(git checkout*)', 'Shell(git switch*)',
  'Shell(git restore*)', 'Shell(git stash*)', 'Shell(git clean*)', 'Shell(git rebase*)', 'Shell(git merge*)',
  'Shell(git branch -D*)', 'Shell(git tag*)', 'Shell(gh *)',
  'Shell(rm -r*)', 'Shell(rm -f*)', 'Shell(rm -R*)', 'Shell(sudo*)', 'Shell(su *)', 'Shell(chmod*)', 'Shell(chown*)',
  'Shell(curl*)', 'Shell(wget*)', 'Shell(ssh*)', 'Shell(scp*)', 'Shell(rsync*)', 'Shell(nc *)', 'Shell(open *)',
  'Shell(osascript*)', 'Shell(launchctl*)', 'Shell(defaults write*)', 'Shell(security *)', 'Shell(kill*)', 'Shell(pkill*)',
  'Shell(xcodebuild*)', 'Shell(swift build*)', 'Shell(swift test*)', 'Shell(npm publish*)', 'Shell(npm install*)',
  'Shell(pip install*)', 'Shell(brew *)',
]

/** Secrets folders under the person's home that a Codex Head must not read. */
export const CODEX_SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.codex', '.claude', '.config/gcloud', '.netrc', '.npmrc', '.git-credentials']

/**
 * Folders under the home folder a Head may read even where the home folder is closed to it (Codex): git's own config and
 * the toolchains a build or test runs from. None of them holds credentials; caches and shell profiles (which often export
 * tokens) are left out. `headReadDirs` adds to this list.
 */
export const HOME_READ_DIRS = [
  '.gitconfig', '.config/git', '.gitignore_global',
  '.nvm', '.volta', '.fnm', '.bun', '.deno', '.local/share/pnpm', 'Library/pnpm',
  '.cargo/bin', '.cargo/registry', '.rustup', '.pyenv', '.rbenv', '.asdf', '.local/share/mise', '.local/bin', '.local/lib',
  '.gradle/caches', '.gradle/wrapper', '.m2/repository', '.sdkman', '.jenv', 'go/pkg', '.konan', '.pub-cache', '.dotnet', '.swiftpm',
  'Library/Android/sdk', 'Library/Java', 'Library/Developer/Toolchains', 'flutter', 'development/flutter',
]

let extraHomeRead: readonly string[] = []

/** The person's `headReadDirs` option: more folders (relative to home, or absolute inside it) a Head may read. */
export const setExtraHomeRead = (dirs: readonly string[]) => {
  extraHomeRead = dirs
}

/** Parses `headReadDirs`: comma or newline separated, `~/` and leading slashes trimmed to a home-relative path. */
export const parseHomeReadDirs = (text: string, home: string) =>
  text.split(/[,\n]/).map(dir => dir.trim()).filter(Boolean)
    .map(dir => (dir.startsWith('~/') ? dir.slice(2) : home && dir.startsWith(`${trimSlash(home)}/`) ? dir.slice(trimSlash(home).length + 1) : dir))
    .map(dir => dir.replace(/\/+$/, ''))
    .filter(dir => !dir.startsWith('/') && !dir.split('/').includes('..') && !CODEX_SECRET_DIRS.some(secret => dir === secret || dir.startsWith(`${secret}/`)))

/** The toolchain folders (and the person's own extra ones) that exist under `home`, home-relative. */
export async function homeReadDirs($: EngineInterface, home: string): Promise<string[]> {
  const wanted = union(HOME_READ_DIRS, parseHomeReadDirs(extraHomeRead.join(','), home))
  const found = await Promise.all(wanted.map(dir => $.fs.exists(`${trimSlash(home)}/${dir}`).catch(() => false)))
  return wanted.filter((_, index) => found[index])
}

/**
 * A project folder a Head must not run in: `/`, the home folder, or a folder above it. Rules that keep a Head inside its
 * project mean nothing there (Codex cannot close the home folder, Command Code has no folder above to deny).
 */
export const homeHeadRefusal = (cwd: string, home: string) => {
  const dir = trimSlash(cwd)
  if (dir === '/' || /^[A-Za-z]:\/?$/.test(dir)) return `${cwd} is the root of the disk. Open Claude Code in a project folder and run the Head there.`
  if (home && isWithin(trimSlash(home), dir)) return `${cwd} is your home folder${trimSlash(home) === dir ? '' : ' or holds it'}. Open Claude Code in a project folder and run the Head there.`
  return undefined
}

export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The write guard Command Code runs before every write and edit: it denies a path whose real location is outside
 * `cwd` and the `writeDirs`, which deny rules cannot express for a new folder (write_file creates missing parents).
 */
export const guardCommand = (pluginRoot: string, cwd: string, writeDirs: readonly string[] = [], isWindows = false) =>
  isWindows
    ? [`py -3 -I ${windowsQuote(`${pluginRoot}/bin/head-guard.py`)}`, ...[cwd, ...writeDirs].map(windowsQuote)].join(' ')
    : [`/usr/bin/env python3 -I ${shellQuote(`${pluginRoot}/bin/head-guard.py`)}`, ...[cwd, ...writeDirs].map(shellQuote)].join(' ')

/** Quotes one argument for a Windows command line (CreateProcess rules): wrapped in double quotes, inner quotes doubled. */
export const windowsQuote = (text: string) => `"${text.replace(/"/g, '""')}"`
