/**
 * @author Shakib
 * @since 25/11/26
 */
import { expect, test } from 'claude-code/testing'

import { agyReportFiles, agySettings, foldAgyRow, newAgyState } from './engines/agy'
import { formatReport, scopeLines, withOtherWrites } from './lib/format'

const tool = (index: number, name: string, parameters: Record<string, unknown>, state = 'DONE') => ({
  event: 'step_update', step_update: { step_index: index, state, step_type: 'tool', tool_name: name, tool_info: { name, parameters } },
})

const report = (files: string[], wrote: boolean) => formatReport({
  id: 'h1', model: 'agy', cwd: '/project', finished: true, rounds: 1, turns: 1,
  usd: null, files, wrote, denied: [], finalText: 'done', exit: 'success',
})

test('attributes completed write and edit calls to the Head', () => {
  const state = newAgyState()
  foldAgyRow(tool(1, 'write_to_file', { TargetFile: 'src/a.ts' }), state)
  foldAgyRow(tool(2, 'replace_file_content', { AbsolutePath: '/project/src/b.ts' }), state)
  foldAgyRow(tool(3, 'multi_replace_file_content', { file_path: 'src/c.ts' }), state)
  foldAgyRow(tool(4, 'write_file', { path: 'src/pending.ts' }, 'ACTIVE'), state)
  const result = agyReportFiles(state, '/project', ['/project/src/a.ts', '/project/src/other.ts'])
  expect(result.files).toEqual(['/project/src/a.ts', '/project/src/b.ts', '/project/src/c.ts'])
  expect(result.folder).toEqual(['src/other.ts'])
  expect(scopeLines('/project', ['src/a.ts'], result.files).join('\n')).not.toContain('named but not changed')
  const text = withOtherWrites(report(result.files, state.wrote), [], result.folder)
  expect(text).toContain('edited (3): src/a.ts, src/b.ts, src/c.ts')
  expect(text).toContain("changed in the folder during the run, not through this Head's file tools: src/other.ts")
})

test('reports folder changes neutrally when the Head only reads', () => {
  const state = newAgyState()
  foldAgyRow(tool(1, 'view_file', { AbsolutePath: '/project/src/a.ts' }), state)
  expect(state.wrote).toBe(false)
  const text = report(['/project/src/other.ts'], state.wrote)
  expect(text).toContain('edited: nothing')
  expect(text).toContain("changed in the folder during the run, not through this Head's file tools: src/other.ts")
  expect(text).not.toContain('⚠')
})

test('resolves relative edit paths before comparing folder changes', () => {
  const state = newAgyState()
  foldAgyRow(tool(1, 'write_file', { path: 'src/../src/a.ts' }), state)
  foldAgyRow(tool(2, 'edit_file', { file_path: '../shared/b.ts' }), state)
  const result = agyReportFiles(state, '/project/app', ['/project/app/src/a.ts', '/project/shared/b.ts', '/project/app/other.ts'])
  expect(result.files).toEqual(['/project/app/src/a.ts', '/project/shared/b.ts'])
  expect(result.folder).toEqual(['other.ts'])
})

test('read-only settings leave search tools available under the read rules', () => {
  const settings = agySettings('/project', { addDirs: ['/extra'], shell: false }, '/home/me', ['/project/.env'])
  expect(settings.permissions.deny).toContain('command(*)')
  expect(settings.permissions.allow).toContain('read_file(/extra/)')
  expect(settings.permissions.deny).toContain('read_file(/project/.env)')
  expect(settings.permissions.deny).toContain('read_file(/project/.git/)')
  expect(settings.permissions.deny.some(rule => rule.startsWith('read_file(/home/me/.ssh'))).toBe(true)
  for (const name of ['list_dir', 'find_by_name', 'grep_search', 'codebase_search', 'view_file']) {
    expect(settings.permissions.deny.some(rule => rule.startsWith(`${name}(`))).toBe(false)
  }
})
