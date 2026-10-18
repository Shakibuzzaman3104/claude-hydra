/**
 * @author Shakib
 * @since 18/10/26
 */
import type { EngineInterface } from 'claude-code'

import { trimSlash } from './safety'

export const IGNORE_FILE = '.hydraignore'

/** More matches than this and the Head is refused: one rule per path would outgrow Codex's and OpenCode's inline configs. */
export const IGNORE_CAP = 200

/**
 * What a Head is kept from beyond `.env`: the paths `.hydraignore` names (`folders` is the subset that are wholly untracked
 * folders), and the `.hydraignore` files themselves, which it may read but never edit.
 */
export type Guarded = { paths: string[]; folders: string[]; ignoreFiles: string[] }

export const NO_GUARD: Guarded = { paths: [], folders: [], ignoreFiles: [] }

/** The paths in `git ls-files -z` output, relative; a folder keeps its trailing slash. */
export const ignoredFrom = (stdout: string) => stdout.split('\0').filter(Boolean)

export const tooManyIgnored = (count: number) =>
  `${IGNORE_FILE} matches ${count} paths, more than the ${IGNORE_CAP} Hydra can deny one by one. Name whole folders (\`secrets/\`) instead of the files in them, then run the Head again.`

export const unreadableIgnore = (file: string, why: string) =>
  `${file} could not be read (${why}). Hydra reads it with git, so the folder must be in a git repository. Fix that or remove the file, then run the Head again.`

/**
 * The paths each root's `.hydraignore` names, matched by git with gitignore rules (anchored at the file's own folder, so a
 * monorepo subfolder works), tracked or not, a wholly untracked folder as one entry. `roots` pairs each folder as given with
 * its real path; both spellings are denied. A root without the file adds nothing. A file git cannot read (no repository, a
 * timeout, cut-short output) refuses the Head: a list that could not be built is never treated as empty.
 */
export async function guardedPaths($: EngineInterface, roots: readonly { path: string; real?: string }[]): Promise<Guarded | { refusal: string }> {
  const paths = new Set<string>()
  const folders = new Set<string>()
  const ignoreFiles = new Set<string>()
  let count = 0
  for (const { path, real } of roots) {
    const root = trimSlash(path)
    const spellings = [...new Set([root, ...(real ? [trimSlash(real)] : [])])]
    const file = `${root}/${IGNORE_FILE}`
    if (!(await $.fs.exists(file).catch(() => true))) continue
    const ran = await $.process
      .run(['git', '-C', root, 'ls-files', '-z', '--cached', '--others', '--ignored', '--directory', `--exclude-per-directory=${IGNORE_FILE}`], { timeoutMs: 30_000 })
      .catch(() => undefined)
    if (!ran) return { refusal: unreadableIgnore(file, 'git could not run or took over 30 seconds') }
    if (ran.exitCode !== 0) return { refusal: unreadableIgnore(file, ran.stderr.trim().split('\n')[0]?.slice(0, 160) || `git exited ${ran.exitCode}`) }
    if (ran.isStdoutTruncated) return { refusal: tooManyIgnored(IGNORE_CAP + 1) }
    const matches = ignoredFrom(ran.stdout)
    count += matches.length
    for (const spelling of spellings) {
      ignoreFiles.add(`${spelling}/${IGNORE_FILE}`)
      for (const rel of matches) {
        const path = `${spelling}/${rel.replace(/\/+$/, '')}`
        paths.add(path)
        if (rel.endsWith('/')) folders.add(path)
      }
    }
  }
  if (count > IGNORE_CAP) return { refusal: tooManyIgnored(count) }
  return { paths: [...paths].sort(), folders: [...folders].sort(), ignoreFiles: [...ignoreFiles].sort() }
}

/** The last part of a path: what a shell rule matches when a command names the file. */
export const baseName = (path: string) => trimSlash(path).split('/').pop() ?? path

/** Each `.hydraignore`'s content, or null when it cannot be read: taken before a Head runs and again after. */
export async function snapshotIgnoreFiles($: EngineInterface, files: readonly string[]): Promise<Map<string, string | null>> {
  const snapshot = new Map<string, string | null>()
  for (const file of files) snapshot.set(file, await $.fs.read(file).catch(() => null))
  return snapshot
}

/** The `.hydraignore` files that are gone or changed since `before`: the next Head would be kept from less. */
export const ignoreChanges = (before: ReadonlyMap<string, string | null>, after: ReadonlyMap<string, string | null>) =>
  [...before].filter(([file, text]) => text !== null && after.get(file) !== text).map(([file]) => file)

export const ignoreChangedLine = (files: readonly string[]) =>
  `⚠ .hydraignore REMOVED OR CHANGED during this Head (${files.join(', ')}): restore it before the next Head runs`
