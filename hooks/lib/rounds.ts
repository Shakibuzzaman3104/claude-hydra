/**
 * @author Shakib
 * @since 10/11/26
 */
import type { Ending } from '../../types'
import { HANDOFF_MS, HANDOFF_TURNS, HEAD_RULES, MAX_ROUNDS, STALL_ROUNDS, START_RETRIES, continuePrompt, endMark, followUpPrompt, handoffPrompt, isResumable, nudgePrompt } from './runtime'
import type { Round } from './runtime'

export type RoundSpec = { prompt: string; maxTurns: number; resume?: string }
export type RanRound = Round & { effort?: string }

/** What `runRounds` needs from an engine: how to run one round, and its counters. The clock and the run record are wired by the caller. */
export type RoundsSteps = {
  task: string
  maxTurns: number
  minutes: number
  /** The Head's stop switch: the Lead, the person or a cancelled call. */
  outer: AbortSignal
  /** An earlier Head's session to continue: the task is then a follow-up, not a fresh start. */
  resume?: string
  runRound: (round: RoundSpec, signal: AbortSignal) => Promise<RanRound>
  /** Turns used so far, as this engine counts them. */
  turns: () => number
  /** Tool calls finished or denied so far: a round that adds none made no progress. */
  calls: () => number
  /** Calls refused so far, as short lines for the continue prompt. */
  denied: (sessionId: string) => string[] | Promise<string[]>
  /** Finds a session the CLI started without naming it in its output. */
  findSession?: () => Promise<string | undefined>
  /** False when a first round that named no session must not be tried again. */
  mayRetryStart?: (round: RanRound) => boolean
  /** False when resuming would only repeat the failure (a usage limit). */
  mayResume?: (round: RanRound) => boolean
  /** Resolves after `ms`; rejects when `signal` aborts first. */
  sleep: (ms: number, signal: AbortSignal) => Promise<unknown>
  onStep?: (activity: string) => Promise<void>
}

export type RoundsResult = {
  round: RanRound
  rounds: number
  sessionId?: string
  ending: Ending
  /** Which limit a `capped` Head ran into. */
  cap?: 'turn' | 'round'
}

const isSuccess = (round: RanRound) => round.code === 0 && round.subtype === 'success'

/**
 * Runs a Head round after round until it ends the run itself (HEAD DONE, HEAD BLOCKED) or cannot go on. A round that stops
 * without an ending is resumed in the same session; `STALL_ROUNDS` rounds in a row without a single tool call stop it as
 * stalled instead of spending every round on the same reply. A Head out of turns, rounds or time gets one short round to
 * write a handoff. Pure but for its steps, so it is tested with fake rounds.
 */
export async function runRounds(steps: RoundsSteps): Promise<RoundsResult> {
  const { task, maxTurns, minutes, outer } = steps
  const controller = new AbortController()
  if (outer.aborted) controller.abort()
  else outer.addEventListener('abort', () => controller.abort(), { once: true })
  let timedOut = false
  const timerStop = new AbortController()
  void Promise.resolve(steps.sleep(minutes * 60_000, timerStop.signal)).then(
    () => {
      timedOut = true
      controller.abort()
    },
    () => undefined,
  )
  const signal = controller.signal

  const first: RoundSpec = steps.resume ? { prompt: followUpPrompt(task), maxTurns, resume: steps.resume } : { prompt: task + HEAD_RULES, maxTurns }
  let callsBefore = steps.calls()
  let silent = 0
  // A round that added no tool call made no progress; `STALL_ROUNDS` of them in a row end the run.
  const countRound = () => {
    silent = steps.calls() === callsBefore ? silent + 1 : 0
    callsBefore = steps.calls()
  }
  let round = await steps.runRound(first, signal)
  // A follow-up is never sent twice: a resume that fails is the caller's to start afresh.
  for (let attempt = 1; !steps.resume && !round.sessionId && !round.startedSession && !signal.aborted && (steps.mayRetryStart?.(round) ?? true) && attempt <= START_RETRIES; attempt++) {
    await Promise.resolve(steps.sleep(attempt * 5_000, signal)).catch(() => undefined)
    round = await steps.runRound(first, signal)
  }
  countRound()
  // A CLI that failed outright on a session to continue (it is gone, or not this account's) has no session: the caller starts afresh.
  const kept = steps.resume && (round.code === null || isResumable(round.code)) ? steps.resume : undefined
  const sessionId = round.sessionId ?? round.startedSession ?? (await steps.findSession?.()) ?? kept
  let rounds = 1
  const mayGoOn = () => !signal.aborted && !!sessionId && isResumable(round.code) && (steps.mayResume?.(round) ?? true) && !endMark(round.finalText)
  while (mayGoOn() && silent < STALL_ROUNDS && rounds < MAX_ROUNDS && steps.turns() < maxTurns) {
    await steps.onStep?.(`resuming (round ${rounds + 1})`)
    const denied = await steps.denied(sessionId!)
    round = await steps.runRound({ prompt: silent > 0 ? nudgePrompt(denied) : continuePrompt(denied), maxTurns: maxTurns - steps.turns(), resume: sessionId }, signal)
    rounds++
    countRound()
  }
  timerStop.abort()

  const mark = endMark(round.finalText)
  const outOfTurns = round.code === 8 || round.subtype === 'error_max_turns' || steps.turns() >= maxTurns
  const outOfRounds = rounds >= MAX_ROUNDS && isResumable(round.code)
  let ending: Ending = mark === 'done' && isSuccess(round) ? 'done'
    : outer.aborted ? 'stopped'
    : timedOut ? 'timeout'
    : mark === 'blocked' ? 'blocked'
    : mark ? 'error'
    : silent >= STALL_ROUNDS && isResumable(round.code) ? 'stalled'
    : outOfTurns || outOfRounds ? 'capped'
    : 'error'
  const cap = ending === 'capped' ? (outOfTurns ? 'turn' as const : 'round' as const) : undefined

  if ((ending === 'capped' || ending === 'timeout') && sessionId && !outer.aborted) {
    // The Head's own signal is spent once its time is up, so the handoff runs on a short one of its own.
    const grace = new AbortController()
    outer.addEventListener('abort', () => grace.abort(), { once: true })
    const graceStop = new AbortController()
    void Promise.resolve(steps.sleep(HANDOFF_MS, graceStop.signal)).then(() => grace.abort(), () => undefined)
    await steps.onStep?.('writing a handoff')
    const handoff = await steps.runRound({ prompt: handoffPrompt(ending === 'timeout' ? 'time' : cap ?? 'turn'), maxTurns: HANDOFF_TURNS, resume: sessionId }, grace.signal)
    graceStop.abort()
    rounds++
    if (handoff.finalText.trim()) {
      if (ending === 'capped' && endMark(handoff.finalText) === 'done' && isSuccess(handoff)) ending = 'done'
      // The run's own failure text stays: the handoff round's exit says nothing about why the Head stopped.
      round = { ...handoff, code: ending === 'done' ? handoff.code : round.code, subtype: ending === 'done' ? handoff.subtype : round.subtype, errors: round.errors }
    }
  }
  return { round, rounds, sessionId, ending, ...(ending === 'capped' && cap ? { cap } : {}) }
}

/** What the views show for a Head that did not finish; undefined for one that did. */
export const endActivity = (result: Pick<RoundsResult, 'ending' | 'cap' | 'round'>, head: { maxTurns: number; minutes: number; stopped?: string }) => {
  switch (result.ending) {
    case 'done': return undefined
    case 'stopped': return head.stopped ?? 'stopped'
    case 'timeout': return `timed out after ${head.minutes} min`
    case 'blocked': return 'blocked: see its report'
    case 'stalled': return 'stalled: replied without acting or finishing'
    case 'capped': return result.cap === 'round' ? `stopped after ${MAX_ROUNDS} rounds` : `stopped at the ${head.maxTurns}-turn cap`
    default: {
      const failure = result.round.errors.trim().split('\n').at(-1)?.trim()
      return failure ? `failed: ${failure.slice(0, 60)}` : 'stopped before HEAD DONE'
    }
  }
}

/** The `exit` of a report's first line: the CLI's own code, or why Hydra stopped the Head. */
export const exitOf = (result: Pick<RoundsResult, 'ending' | 'round'>, head: { minutes: number; stopped?: string }) =>
  result.ending === 'timeout' ? `timed out after ${head.minutes} min` : result.ending === 'stopped' ? head.stopped ?? 'stopped' : String(result.round.code ?? result.round.signal)

/** Counts the tool calls in an engine's event stream, so `runRounds` can tell a round that did nothing. */
export const createCallCounter = () => {
  let calls = 0
  return {
    get calls() { return calls },
    see(event: { type: string }) {
      if (event.type === 'tool_completed' || event.type === 'tool_denied') calls++
    },
  }
}
