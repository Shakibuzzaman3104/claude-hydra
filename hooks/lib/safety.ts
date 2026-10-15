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

/**
 * Credential files and folders under the person's home, home-relative: SSH and GPG keys, cloud and registry logins, git
 * credential stores, password managers and the agent CLIs' own sign-ins. No Head reads them, whatever folder it was granted:
 * every engine's lockdown denies them, and a grant inside one is refused.
 */
export const SECRET_PATHS = [
  '.ssh', '.gnupg', '.netrc', '.git-credentials', '.config/git/credentials', '.password-store', 'Library/Keychains',
  '.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.terraform.d', '.vault-token', '.boto', '.s3cfg', '.config/doctl', '.config/op',
  '.config/gh', '.config/hub', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.cargo/credentials', '.cargo/credentials.toml',
  '.gradle/gradle.properties', '.gradle/init.d', '.m2/settings.xml', '.m2/settings-security.xml', '.pub-cache/credentials.json',
  '.config/dart', '.dotnet/corefx', '.android/adbkey',
  '.codex', '.claude', '.commandcode', '.codebuddy', '.gemini', '.config/opencode', '.local/share/opencode', '.workbuddy-ai',
]

/** Whether a home-relative path is a credential path or inside one. */
export const isSecretPath = (rel: string) => SECRET_PATHS.some(secret => rel === secret || rel.startsWith(`${secret}/`))

/** Whether a home-relative path holds a credential path (granting it would grant the secret on an engine without "more specific wins"). */
export const holdsSecret = (rel: string) => SECRET_PATHS.some(secret => secret.startsWith(`${rel}/`))

/** `path` relative to `home`, or undefined when it is not inside it. */
export const homeRelative = (path: string, home: string) => {
  const base = trimSlash(home)
  return base && path.startsWith(`${base}/`) ? trimSlash(path).slice(base.length + 1) : undefined
}

/** Refusal text when one of `dirs` (real paths) is a credential path or inside one, under the real `home`. */
export const secretDirRefusal = (dirs: readonly string[], home: string, what: string) => {
  const secret = dirs.find(dir => {
    const rel = homeRelative(dir, home)
    return rel !== undefined && isSecretPath(rel)
  })
  return secret ? `${what}: ${secret} is a credential folder (or inside one), which a Head never reads.` : undefined
}

/**
 * Folders under the home folder a Head may read even where the home folder is closed to it (Codex): git's own config and
 * the toolchains a build or test runs from. Caches and shell profiles (which often export tokens) are left out, and the
 * credential files some of these hold (`.config/git/credentials`, `.pub-cache/credentials.json`…) stay denied through
 * `SECRET_PATHS`, the more specific rule. `headReadDirs` adds to this list.
 */
export const HOME_READ_DIRS = [
  '.gitconfig', '.config/git', '.gitignore_global',
  '.nvm', '.volta', '.fnm', '.bun', '.deno', '.local/share/pnpm', 'Library/pnpm', '.npm/_npx',
  '.cargo/bin', '.cargo/registry', '.rustup', '.pyenv', '.rbenv', '.asdf', '.local/share/mise', '.local/bin', '.local/lib', 'Library/Python', '.gem',
  '.gradle/caches', '.gradle/wrapper', '.m2/repository', '.sdkman', '.jenv', 'go/pkg', '.konan', '.pub-cache', '.dotnet', '.swiftpm',
  'Library/Android/sdk', 'Library/Java', 'Library/Developer/Toolchains', 'flutter', 'development/flutter', 'miniconda3', 'anaconda3', '.conda',
]

let extraHomeRead: readonly string[] = []

/** The person's `headReadDirs` option: more folders (relative to home, or absolute inside it) a Head may read. */
export const setExtraHomeRead = (dirs: readonly string[]) => {
  extraHomeRead = dirs
}

/**
 * Parses `headReadDirs`: comma or newline separated, `~/` and the home prefix trimmed to a home-relative path. An entry
 * outside home, with `..`, empty or `.`, or that is, sits in or holds a credential path is dropped.
 */
export const parseHomeReadDirs = (text: string, home: string) =>
  text.split(/[,\n]/).map(dir => dir.trim()).filter(Boolean)
    .map(dir => (dir.startsWith('~/') ? dir.slice(2) : home && dir.startsWith(`${trimSlash(home)}/`) ? dir.slice(trimSlash(home).length + 1) : dir))
    .map(dir => dir.replace(/\/+$/, '').replace(/^(\.\/)+/, ''))
    .filter(dir => dir !== '' && !dir.startsWith('/') && !dir.split('/').some(part => part === '..' || part === '.' || part === '') && !isSecretPath(dir) && !holdsSecret(dir))

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
