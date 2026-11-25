/**
 * @author Shakib
 * @since 25/11/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { sweepOpenCodeFiles } from './engines/opencode'
import { sweepHunts } from './lib/launch'
import { newestMtime } from './lib/platform'

const DAY = 86_400_000
const NOW = 100 * DAY
const HOME = '/home/me'
const OWN = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const STALE = '33333333-3333-3333-3333-333333333333'

/** A fake disk whose `list` gives folders an mtime of 0, as `$.fs.list` does; `stat` gives the real one. */
function fakeDisk(tree: Record<string, { kind: 'file' | 'dir'; mtimeMs: number }>) {
  const removed: string[] = []
  const childrenOf = (path: string) => Object.keys(tree).filter(each => each.startsWith(`${path}/`) && !each.slice(path.length + 1).includes('/'))
  const $ = {
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    clock: { now: async () => NOW },
    session: { id: async () => OWN },
    store: { keys: async () => [], get: async () => undefined, delete: async () => undefined },
    platform: { os: 'darwin' },
    fs: {
      stat: async (path: string) => { const node = tree[path]; if (!node) throw new Error('ENOENT'); return { ...node, size: 0 } },
      list: async (path: string) => childrenOf(path).map(each => ({ name: each.slice(path.length + 1), kind: tree[each]!.kind, size: 0, mtimeMs: tree[each]!.kind === 'dir' ? 0 : tree[each]!.mtimeMs, isLink: false })),
    },
    process: { run: async (argv: string[]) => { if (argv[0] === '/bin/rm') removed.push(...argv.slice(2)); return { exitCode: 0, stdout: '', stderr: '' } } },
  } as unknown as EngineInterface
  return { $, removed }
}

const dir = (mtimeMs: number) => ({ kind: 'dir' as const, mtimeMs })
const file = (mtimeMs: number) => ({ kind: 'file' as const, mtimeMs })

test('a folder is as new as its newest entry, though listing gives folders an mtime of 0', async () => {
  const { $ } = fakeDisk({ '/a': dir(NOW - 9 * DAY), '/a/b': dir(NOW - 9 * DAY), '/a/b/report.md': file(NOW - DAY) })
  expect(await newestMtime($, '/a', 2)).toBe(NOW - DAY)
  expect(await newestMtime($, '/a', 0)).toBe(NOW - 9 * DAY)
  expect(await newestMtime($, '/missing', 2)).toBeUndefined()
})

test('another session\'s fresh hunt and report folders survive the sweep; only week-old ones go', async () => {
  const hunts = `${HOME}/.claude/hydra/hunts`
  const heads = `${HOME}/.claude/hydra/heads`
  const { $, removed } = fakeDisk({
    [hunts]: dir(NOW),
    [`${hunts}/${OTHER}`]: dir(NOW - 9 * DAY),
    [`${hunts}/${OTHER}/audit`]: dir(NOW - 9 * DAY),
    [`${hunts}/${OTHER}/audit/hunt.md`]: file(NOW - 60_000),
    [`${hunts}/${STALE}`]: dir(NOW - 9 * DAY),
    [`${hunts}/${STALE}/old`]: dir(NOW - 9 * DAY),
    [`${hunts}/${STALE}/old/hunt.md`]: file(NOW - 8 * DAY),
    [`${hunts}/${OWN}`]: dir(NOW - 30 * DAY),
    [heads]: dir(NOW),
    [`${heads}/${OTHER}`]: dir(NOW - 9 * DAY),
    [`${heads}/${OTHER}/api.md`]: file(NOW - 60_000),
    [`${heads}/${STALE}`]: dir(NOW - 9 * DAY),
    [`${heads}/${STALE}/api.md`]: file(NOW - 8 * DAY),
  })
  await sweepHunts($)
  expect(removed.sort()).toEqual([`${heads}/${STALE}`, `${hunts}/${STALE}`])
})

test('a running OpenCode Head\'s config folder in another session survives the sweep', async () => {
  const heads = `${HOME}/.claude/hydra/heads`
  const { $, removed } = fakeDisk({
    [heads]: dir(NOW),
    [`${heads}/opencode-live`]: dir(NOW - 3 * DAY),
    [`${heads}/opencode-live/config.json`]: file(NOW - 60_000),
    [`${heads}/opencode-dead.json`]: file(NOW - 3 * DAY),
  })
  await sweepOpenCodeFiles($)
  expect(removed).toEqual([`${heads}/opencode-dead.json`])
})
