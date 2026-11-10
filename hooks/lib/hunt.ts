/**
 * @author Shakib
 * @since 11/11/26
 */
import type { Schema } from './schema'
import { schemaProblem } from './schema'

export const HUNT_MAX_HEADS = 24
export const HUNT_MAX_LENSES = 3
export const DEFAULT_LENS = 'correctness'
export const VERDICT_SCHEMA: Schema = { type: 'object', properties: { verdict: { type: 'string', enum: ['holds', 'broken', 'unsure'] }, problems: { type: 'array', maxItems: 15, items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, problem: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] } }, required: ['problem', 'severity'] } }, checked: { type: 'array', items: { type: 'string' } } }, required: ['verdict', 'problems', 'checked'] }

export type HuntHead = { name: string; task: string; engine?: string; model?: string; effort?: string; files?: string[]; check?: string; checkMinutes?: number; shell?: boolean; cwd?: string; addDirs?: string[]; writeDirs?: string[]; maxTurns?: number; maxMinutes?: number }
export type HuntRefute = { lenses: string[]; fix: boolean }
export type HuntPlan = { name: string; shared: string; schema?: Schema; heads: HuntHead[]; refute?: HuntRefute; fresh: boolean }
export type Problem = { file?: string; line?: number; problem: string; severity: string }
export type Verdict = 'holds' | 'broken' | 'unsure' | 'none'
export type HeadStatus = 'done' | 'blocked' | 'unfinished' | 'failed' | 'invalid'
export type HeadCall = HuntHead & { schema?: Schema; resume?: string }
export type HeadRan = { engine: string; model?: string; isDone: boolean; ending?: string; check?: 'passed' | 'failed' | 'unknown'; files: string[]; summary: string; data?: unknown; dataErrors?: string[]; reportPath?: string; cost?: string; isResumable: boolean }
export type HeadOutcome = { name: string; engine: string; model?: string; status: HeadStatus; isCached: boolean; check?: 'passed' | 'failed' | 'unknown'; files: string[]; summary: string; data?: unknown; dataErrors?: string[]; reportPath?: string; cost?: string; refute?: { verdict: Verdict; by: string[]; problems: Problem[]; fixRounds: number; edited: string[] } }
export type HuntResult = { name: string; outcomes: HeadOutcome[]; missing: string[] }
export type HuntSteps = { plan: HuntPlan; cache: Readonly<Record<string, HeadOutcome>>; runHead: (call: HeadCall) => Promise<HeadRan>; refuterEngine: (author: string, index: number) => string | undefined; save: (key: string, outcome: HeadOutcome) => Promise<void>; isAborted: () => boolean }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []
const slug = (value: string, max: number) => value.length <= max && /^[a-z0-9][a-z0-9-]*$/.test(value)

export const parseHunt = (input: Readonly<Record<string, unknown>>): { plan: HuntPlan } | { deny: string } => {
  const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : ''
  if (!slug(name, 30)) return { deny: 'A hunt needs a `name`: lowercase letters, digits and dashes, up to 30 (it names the Heads and the cache).' }
  if (Array.isArray(input.heads) && input.heads.length > HUNT_MAX_HEADS) return { deny: `A hunt takes at most ${HUNT_MAX_HEADS} Heads; split it into two hunts.` }
  if (!Array.isArray(input.heads) || input.heads.length === 0 || !input.heads.every(object)) return { deny: `\`heads\` must list 1 to ${HUNT_MAX_HEADS} Heads, each with a \`task\`.` }
  const heads: HuntHead[] = []
  for (const [index, entry] of input.heads.entries()) {
    if (typeof entry.task !== 'string' || !entry.task.trim()) return { deny: `Head ${index + 1} has no \`task\`.` }
    const headName = entry.name === undefined ? `${name.slice(0, 16)}-${index + 1}` : typeof entry.name === 'string' ? entry.name.trim().toLowerCase() : ''
    if (!slug(headName, 20)) return { deny: `Head ${index + 1}: \`name\` must be lowercase letters, digits and dashes, up to 20.` }
    if (/-fix$|-r\d+$|-json\d*$/.test(headName)) return { deny: `Head ${index + 1}: the name "${headName}" ends like one of the hunt's own follow-up Heads (-fix, -r1, -json); pick another.` }
    if (heads.some(head => head.name === headName)) return { deny: `Two Heads are named "${headName}"; names must differ.` }
    const head: HuntHead = { name: headName, task: entry.task.trim() }
    for (const key of ['engine', 'model', 'effort', 'check', 'cwd'] as const) if (typeof entry[key] === 'string' && entry[key].trim()) head[key] = entry[key].trim()
    for (const key of ['files', 'addDirs', 'writeDirs'] as const) { const values = strings(entry[key]); if (values.length) head[key] = values }
    for (const key of ['checkMinutes', 'maxTurns', 'maxMinutes'] as const) { const value = entry[key]; if (typeof value === 'number' && Number.isFinite(value) && value > 0) head[key] = value }
    if (entry.shell === true) head.shell = true
    heads.push(head)
  }
  let schema: Schema | undefined
  if (input.schema !== undefined && input.schema !== null) {
    const problem = schemaProblem(input.schema)
    if (problem !== undefined) return { deny: `\`schema\`: ${problem}.` }
    schema = input.schema as Schema
  }
  let refute: HuntRefute | undefined
  if (input.refute === true) refute = { lenses: [DEFAULT_LENS], fix: true }
  else if (object(input.refute)) {
    const lenses = [...new Set(strings(input.refute.lenses))]
    if (lenses.length > HUNT_MAX_LENSES) return { deny: `\`refute.lenses\` takes at most ${HUNT_MAX_LENSES}.` }
    refute = { lenses: lenses.length ? lenses : [DEFAULT_LENS], fix: input.refute.fix !== false }
  } else if (input.refute !== undefined && input.refute !== null && input.refute !== false) return { deny: '`refute` must be true or { lenses, fix }.' }
  return { plan: { name, shared: typeof input.shared === 'string' ? input.shared.trim() : '', ...(schema !== undefined ? { schema } : {}), heads, ...(refute ? { refute } : {}), fresh: input.fresh === true } }
}

export const headKey = (plan: HuntPlan, head: HuntHead): string => {
  const text = JSON.stringify([plan.shared, plan.schema ?? null, plan.refute ?? null, head.name, head.task, head.engine ?? '', head.model ?? '', head.effort ?? '', head.files ?? [], head.check ?? '', head.cwd ?? '', head.shell === true])
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return `${head.name}:${hash.toString(16).padStart(8, '0')}`
}

export const refuteTask = (head: HuntHead, shared: string, author: Pick<HeadRan, 'summary' | 'files' | 'data'>, lens: string): string => [
  `You are a refuter. Another agent just did the task below. Your job is to find what is wrong with its result, through the lens of ${lens}. Change no files. Read the code as it is now and check each claim against it.`,
  shared ? `Context:\n${shared}` : '',
  `The task it was given:\n${head.task}`,
  author.files.length ? `Files it changed:\n${author.files.map(file => `- ${file}`).join('\n')}` : '',
  author.data !== undefined ? `Its result:\n${JSON.stringify(author.data, null, 1).slice(0, 6000)}` : author.summary ? `Its report:\n${author.summary.slice(0, 3000)}` : '',
  'Answer "broken" only for a concrete problem you can point to (file and line where there is one), "holds" when you checked and found none, and "unsure" when you could not check. Never invent a problem to have one. List what you actually checked.',
].filter(Boolean).join('\n\n')

export const fixTask = (problems: readonly Problem[]): string => `A reviewer checked your work and reports these problems:\n${problems.slice(0, 15).map(p => `- [${p.severity}] ${p.file ? `${p.file}${p.line ? `:${p.line}` : ''}: ` : ''}${p.problem}`).join('\n')}\nFor each one: fix it if it is real, or say in one line why it is not. Then give your full result again.`

export const statusOf = (ran: HeadRan, hasSchema: boolean): HeadStatus => {
  if (ran.check === 'failed') return 'failed'
  if (ran.isDone && hasSchema && ran.data === undefined) return 'invalid'
  if (ran.isDone) return 'done'
  if (ran.ending === 'blocked') return 'blocked'
  if (ran.ending === 'capped' || ran.ending === 'timeout' || ran.ending === 'stalled') return 'unfinished'
  return 'failed'
}

const usable = (value: unknown): value is Record<string, unknown> => object(value) && (value.verdict === 'holds' || value.verdict === 'broken' || value.verdict === 'unsure')
export const verdictOf = (answers: readonly unknown[]): { verdict: Verdict; problems: Problem[] } => {
  const valid = answers.filter(usable)
  if (!valid.length) return { verdict: 'none', problems: [] }
  const problems: Problem[] = []
  const seen = new Set<string>()
  for (const answer of valid) if (answer.verdict === 'broken' && Array.isArray(answer.problems)) for (const item of answer.problems) {
    if (!object(item) || typeof item.problem !== 'string') continue
    const file = typeof item.file === 'string' ? item.file : undefined
    const line = typeof item.line === 'number' && Number.isInteger(item.line) ? item.line : undefined
    const key = `${file ?? ''}:${line ?? ''}:${item.problem}`
    if (!seen.has(key) && problems.length < 15) { seen.add(key); problems.push({ ...(file !== undefined ? { file } : {}), ...(line !== undefined ? { line } : {}), problem: item.problem, severity: typeof item.severity === 'string' ? item.severity : 'medium' }) }
  }
  if (problems.length) return { verdict: 'broken', problems }
  return { verdict: valid.every(answer => answer.verdict === 'holds') ? 'holds' : 'unsure', problems: [] }
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])]
const outcomeOf = (name: string, ran: HeadRan, hasSchema: boolean): HeadOutcome => ({ name, engine: ran.engine, ...(ran.model !== undefined ? { model: ran.model } : {}), status: statusOf(ran, hasSchema), isCached: false, ...(ran.check !== undefined ? { check: ran.check } : {}), files: ran.files, summary: ran.summary, ...(ran.data !== undefined ? { data: ran.data } : {}), ...(ran.dataErrors !== undefined ? { dataErrors: ran.dataErrors } : {}), ...(ran.reportPath !== undefined ? { reportPath: ran.reportPath } : {}), ...(ran.cost !== undefined ? { cost: ran.cost } : {}) })

export async function runHunt(steps: HuntSteps): Promise<HuntResult> {
  const { plan } = steps
  const outcomes = await Promise.all(plan.heads.map(async head => {
    const failure = (summary: string): HeadOutcome => ({ name: head.name, engine: head.engine ?? '', status: 'failed', isCached: false, files: [], summary })
    try {
      const key = headKey(plan, head)
      const cached = steps.cache[key]
      if (!plan.fresh && cached?.status === 'done' && cached.refute?.verdict !== 'broken') return { ...cached, isCached: true }
      if (steps.isAborted()) return failure('not started: the hunt was stopped')
      let ran: HeadRan
      try { ran = await steps.runHead({ ...head, task: plan.shared ? `${plan.shared}\n\n${head.task}` : head.task, ...(plan.schema ? { schema: plan.schema } : {}) }) } catch (error) { return failure(`could not run: ${String(error).slice(0, 300)}`) }
      let outcome = outcomeOf(head.name, ran, plan.schema !== undefined)
      const review = async (author: HeadRan, suffix: string) => {
        const answers = await Promise.all((plan.refute?.lenses ?? []).map(async (lens, index) => {
          const engine = steps.refuterEngine(ran.engine, index)
          if (engine === undefined) return undefined
          try { const result = await steps.runHead({ name: `${head.name}-r${index + 1}${suffix}`, task: refuteTask(head, plan.shared, author, lens), engine, effort: 'medium', schema: VERDICT_SCHEMA, ...(head.cwd ? { cwd: head.cwd } : {}), ...(head.addDirs ? { addDirs: head.addDirs } : {}) }); return { engine, result } } catch { return undefined }
        }))
        const present = answers.filter((answer): answer is { engine: string; result: HeadRan } => answer !== undefined)
        return { ...verdictOf(present.map(answer => answer.result.data)), by: present.filter(answer => usable(answer.result.data)).map(answer => answer.engine), edited: [...new Set(present.flatMap(answer => answer.result.files))] }
      }
      if (plan.refute && outcome.status === 'done' && !steps.isAborted()) {
        const first = await review(ran, '')
        outcome.refute = { ...first, fixRounds: 0 }
        if (first.verdict === 'broken' && plan.refute.fix && ran.isResumable && !steps.isAborted()) {
          let fixed: HeadRan | undefined
          try { fixed = await steps.runHead({ ...head, name: `${head.name}-fix`, resume: head.name, task: fixTask(first.problems), ...(plan.schema ? { schema: plan.schema } : {}) }) } catch { /* Keep the original result. */ }
          if (fixed) {
            const updated = outcomeOf(head.name, fixed, plan.schema !== undefined)
            updated.engine = ran.engine
            if (ran.model !== undefined) updated.model = ran.model
            else delete updated.model
            updated.files = union(ran.files, fixed.files)
            if (ran.cost !== undefined && fixed.cost !== undefined) updated.cost = `${ran.cost} + ${fixed.cost}`
            else if (ran.cost !== undefined) updated.cost = ran.cost
            const second = await review(fixed, 'b')
            updated.refute = { ...second, by: union(first.by, second.by), edited: union(first.edited, second.edited), fixRounds: 1 }
            outcome = updated
          }
        }
      }
      if (outcome.status === 'done') try { await steps.save(key, outcome) } catch { /* Saving must not fail the hunt. */ }
      return outcome
    } catch (error) { return failure(`could not run: ${String(error).slice(0, 300)}`) }
  }))
  return { name: plan.name, outcomes, missing: outcomes.filter(outcome => outcome.status !== 'done').map(outcome => outcome.name) }
}

export const formatHunt = (result: HuntResult, limit = 14000): string => {
  const done = result.outcomes.filter(outcome => outcome.status === 'done').length
  const cached = result.outcomes.filter(outcome => outcome.isCached).length
  const broken = result.outcomes.filter(outcome => outcome.refute?.verdict === 'broken').length
  const first = `hunt ${result.name} · ${result.outcomes.length} Head(s) · ${done} done${cached ? ` (${cached} from cache)` : ''}${broken ? ` · ${broken} refuted` : ''}${result.missing.length ? ` · missing: ${result.missing.join(', ')}` : ''}`
  const share = Math.max(0, Math.floor((limit - first.length - 2 * result.outcomes.length) / (result.outcomes.length || 1)))
  const blocks = result.outcomes.map(outcome => {
    const refute = outcome.refute
    const lines = [`## ${outcome.name} · ${outcome.engine || 'no engine'} · ${outcome.status}${outcome.isCached ? ' (cached)' : ''}${outcome.check ? ` · check ${outcome.check}` : ''}${refute ? ` · refute: ${refute.verdict}${refute.by.length ? ` by ${refute.by.join(', ')}` : ''}${refute.fixRounds ? ' after a fix' : ''}` : ''}${outcome.cost ? ` · ${outcome.cost}` : ''}`]
    if (outcome.files.length) lines.push(`edited: ${outcome.files.slice(0, 12).join(', ')}${outcome.files.length > 12 ? ` and ${outcome.files.length - 12} more` : ''}`)
    if (refute?.edited.length) lines.push(`⚠ a refuter changed files though told not to: ${refute.edited.join(', ')}`)
    if (refute?.problems.length) lines.push('open problems:', ...refute.problems.map(p => `- [${p.severity}] ${p.file ? `${p.file}${p.line ? `:${p.line}` : ''}: ` : ''}${p.problem}`))
    if (outcome.data !== undefined) lines.push(`data: ${JSON.stringify(outcome.data)}`)
    else if (outcome.dataErrors?.length) lines.push(`no usable JSON: ${outcome.dataErrors.slice(0, 3).join('; ')}`, outcome.summary)
    else if (outcome.summary) lines.push(outcome.summary)
    if (outcome.reportPath) lines.push(`full report: ${outcome.reportPath}`)
    const block = lines.join('\n')
    if (block.length <= share) return block
    const marker = `\n… cut: read the full report${outcome.reportPath ? ` at ${outcome.reportPath}` : ''}`
    return share >= marker.length ? block.slice(0, share - marker.length) + marker : marker.slice(0, share)
  })
  return [first, ...blocks].join('\n\n')
}
