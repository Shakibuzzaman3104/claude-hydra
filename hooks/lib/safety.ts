/**
 * @author Shakib
 * @since 15/10/26
 */


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

export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The write guard Command Code runs before every write and edit: it denies a path whose real location is outside
 * `cwd` and the `writeDirs`, which deny rules cannot express for a new folder (write_file creates missing parents).
 */
export const guardCommand = (pluginRoot: string, cwd: string, writeDirs: readonly string[] = []) =>
  [`/usr/bin/env python3 -I ${shellQuote(`${pluginRoot}/bin/head-guard.py`)}`, ...[cwd, ...writeDirs].map(shellQuote)].join(' ')
