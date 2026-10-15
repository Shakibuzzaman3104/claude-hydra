/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface, RenderInput } from 'claude-code'

import { effortModeOf } from './effort'
import { ENGINE_LABEL, engineLabel, isAuto, isEngine } from './engines'
import type { Engine } from './engines'
import { bandLayout, barOf, clockOf, colorOf, compactNumber, elapsedOf, engineMixOf, engineMixText, fitText, glyphColor, glyphOf, headsSummary, isLive, isNoSpend, leadLabel, nowLine, percentOf, resetsIn, shortModel, spendText, timelineBar, timelineLayout, timelineRowCount, timelineSpan, totalsLines, totalsOf } from './format'
import type { HeadLimits } from './format'
import { stopHeadsNow } from './runtime'
import { readHeads, readLead, readMode, readRuns, readSelected, readTick, updateSelected } from './state'

/** Cells a view may draw across: the narrower of the site's own width and the surface's, 80 where neither is known. */
const columnsOf = (e: { props: { bodyColumns?: number }; viewport?: { columns: number } }) => Math.min(e.props.bodyColumns ?? 80, e.viewport?.columns ?? 80)

/** The band above the prompt: one row per live Head, or `undefined` when none is live (the engine then draws its own). */
export async function bandView($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  const now = await readTick($)
  const frame = Math.floor(now / 1000)
  const live = (await readRuns($)).filter(run => isLive(run, now))
  if (live.length === 0) return undefined
  const isRouted = isAuto(await readMode($))
  const { Box, Text } = $.ui.resolve(e)
  const layout = bandLayout(columnsOf(e), isRouted)
  const spend = spendText(totalsOf(live, now))

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>🐉 Hydra </Text>
        <Text dimColor wrap="truncate-end">{headsSummary(live)}{spend ? ` · ${spend}` : ''} · /heads for detail</Text>
      </Box>
      {live.map(run => (
        <Box key={run.id}>
          <Text color={glyphColor(run)}>{glyphOf(run, frame)} </Text>
          <Text bold>{fitText(run.id, layout.idWidth)} </Text>
          {isRouted && <Text color="cyan">{fitText(run.engine ?? '', layout.engineWidth)} </Text>}
          {layout.showEffort && <Text dimColor>{(run.effort ?? '').padEnd(5)} </Text>}
          {layout.showBar && <Text color={glyphColor(run)}>{barOf(run.maxTurns ? (run.turns / run.maxTurns) * 100 : 0, 8)} </Text>}
          <Text dimColor>{layout.showTurns ? `${String(run.turns).padStart(2)}/${run.maxTurns ?? '?'} ` : ''}{elapsedOf(run, now).padStart(5)} </Text>
          <Text wrap="truncate-end" dimColor={run.state !== 'running'}>{nowLine(run)}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** The `/heads` pane: every Head in this session and the chosen one's progress, steps and report. */
export async function headsPaneView($: EngineInterface, e: RenderInput<'Pane'>, defaultEngine: Engine, limits: HeadLimits) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const now = await readTick($)
  const frame = Math.floor(now / 1000)
  const hydra = await readMode($)
  const list = [...(await readRuns($))].reverse()
  const pick = await readSelected($)
  const chosen = list.find(run => run.id === pick) ?? list.find(run => run.state === 'running') ?? list[0]
  const at = chosen ? list.indexOf(chosen) : -1
  const pickAt = (index: number) => {
    const target = list[Math.max(0, Math.min(list.length - 1, index))]
    if (target) void updateSelected($, () => target.id)
  }
  const barWidth = Math.max(10, Math.min(30, e.props.bodyColumns - 24))
  // Oldest first, so the timeline reads top to bottom as the session went; the span covers only the rows shown.
  const timeline = [...list].reverse().slice(-timelineRowCount(e.props.scroll?.bodyRows ?? 24, list.length))
  const span = timelineSpan(timeline, now)
  const layout = timelineLayout(columnsOf(e))
  const [counts, work] = totalsLines(totalsOf(list, now))
  const mixText = engineMixText(list, defaultEngine)

  return (
    <Box flexDirection="column">
      <Text bold>🐉 Hydra · {hydra?.isOn ? `${engineLabel(hydra, defaultEngine)} · ${shortModel(hydra.headModel)} · effort ${effortModeOf(hydra)}` : 'off'}</Text>
      {list.length === 0 && <Text dimColor>No Heads in this session yet. Claude starts them once Hydra is on (/hydra).</Text>}
      {list.length > 0 && <Text wrap="wrap">{counts}</Text>}
      {list.length > 0 && <Text dimColor wrap="wrap">{work}</Text>}
      {mixText !== '' && <Text dimColor wrap="wrap">{mixText}</Text>}
      {list.length > 0 && <Text dimColor wrap="wrap">1-9 or j/k to pick a Head, s to stop it</Text>}
      {list.length > 1 && (
        <Box>
          <Button key="next-head" plain hotkey="j" label="next" onPress={() => pickAt(at + 1)} />
          <Text> </Text>
          <Button key="prev-head" plain hotkey="k" label="previous" onPress={() => pickAt(at - 1)} />
        </Box>
      )}
      {timeline.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Timeline <Text dimColor>{timeline.length < list.length ? `last ${timeline.length} of ${list.length} · ` : ''}{clockOf(span.end - span.start)} span</Text></Text>
          {timeline.map(run => {
            const cells = timelineBar(run, span, layout.barWidth, now)
            return (
              <Box key={`line-${run.id}`}>
                <Text color={glyphColor(run)}>{glyphOf(run, frame)} </Text>
                <Text bold={run.id === chosen?.id}>{fitText(run.id, layout.nameWidth)} </Text>
                {run.startedAt === undefined ? (
                  <Text dimColor>{'┄'.repeat(layout.barWidth)}</Text>
                ) : (
                  <Box>
                    <Text dimColor>{'─'.repeat(cells.before)}</Text>
                    <Text color={glyphColor(run)}>{'━'.repeat(cells.bar)}</Text>
                    <Text dimColor>{'─'.repeat(cells.after)}</Text>
                  </Box>
                )}
                <Text dimColor> {elapsedOf(run, now).padStart(5)}</Text>
              </Box>
            )
          })}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {list.map((run, index) => (
          <Box key={run.id}>
            <Button key={`pick-${run.id}`} plain hotkey={index < 9 ? String(index + 1) : undefined} label={run.id} onPress={() => updateSelected($, () => run.id)} />
            <Text color={glyphColor(run)}> {glyphOf(run, frame)} </Text>
            <Text dimColor>{elapsedOf(run, now).padStart(5)} {String(run.turns).padStart(3)}t </Text>
            <Text wrap="truncate-end" bold={run.id === chosen?.id}>{run.task}</Text>
          </Box>
        ))}
      </Box>
      {chosen && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            {chosen.id} · {shortModel(chosen.model)}{chosen.effort ? ` · effort ${chosen.effort}` : ''} · {chosen.state} {elapsedOf(chosen, now)}
          </Text>
          <Text dimColor wrap="wrap">{chosen.task}</Text>
          {(chosen.state === 'running' || chosen.state === 'queued') && (
            <Box marginTop={1}>
              <Button key="stop-head" hotkey="s" label={`Stop ${chosen.id}`} onPress={() => stopHeadsNow($, [chosen.id], 'stopped from /heads', limits)} />
            </Box>
          )}
          <Box marginTop={1}>
            <Text>turn {chosen.turns}/{chosen.maxTurns ?? '?'} </Text>
            <Text color={glyphColor(chosen)}>{barOf(chosen.maxTurns ? (chosen.turns / chosen.maxTurns) * 100 : 0, barWidth)}</Text>
          </Box>
          <Text dimColor>
            {chosen.edits ?? 0} edits · {chosen.denials ?? 0} denied{chosen.costUsd !== undefined ? ` · $${chosen.costUsd.toFixed(4)}` : chosen.tokens ? ` · ${chosen.tokens}` : ''}
          </Text>
          <Box marginTop={1}>
            <Text color={glyphColor(chosen)}>{glyphOf(chosen, frame)} </Text>
            <Text wrap="truncate-end">{nowLine(chosen)}</Text>
          </Box>
          {(chosen.steps ?? []).map((step, index) => (
            <Box key={`step-${index}`}>
              <Text color={step.isOk ? 'green' : 'red'}>  {step.isOk ? '✓' : '✗'} </Text>
              <Text wrap="truncate-end" dimColor={step.isOk}>{step.text}{step.isOk ? '' : ' (denied)'}</Text>
            </Box>
          ))}
          {chosen.files && chosen.files.length > 0 && (
            <Box marginTop={1}>
              <Text wrap="wrap">edited ({chosen.files.length}): {chosen.files.join(', ')}</Text>
            </Box>
          )}
          {chosen.summary && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Report</Text>
              <Text dimColor wrap="wrap">{chosen.summary}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

/** The `/hydra-usage` pane: Claude's limits, the Heads' spend against theirs, and Hydra's state. */
export async function usagePaneView(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
  { defaultEngine, fiveHourUsd, weeklyUsd, plan }: { defaultEngine: Engine; fiveHourUsd: number; weeklyUsd: number; plan: string },
) {
  const { Box, Text } = $.ui.resolve(e)
  const now = await $.clock.now()
  const width = Math.max(10, Math.min(40, (e.viewport?.columns ?? 50) - 6))
  const windows = await readLead($)
  const usage = await readHeads($)
  const hydra = await readMode($)
  const recent = await readRuns($)
  const mix = engineMixOf(recent, defaultEngine)

  const row = (label: string, percent: number, detail: string) => (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text>{label}</Text>
        <Text dimColor>
          {detail} {Math.round(percent)}%
        </Text>
      </Box>
      <Text color={colorOf(percent)}>{barOf(percent, width)}</Text>
    </Box>
  )

  const spend = (label: string, usd: number, limit: number, resetsAt: string | null) =>
    limit > 0 ? (
      row(`${label} limit · $${limit.toFixed(2)}`, percentOf(usd, limit), `$${usd.toFixed(2)} ${resetsIn(resetsAt, now)}`)
    ) : (
      <Box key={label} justifyContent="space-between">
        <Text>{label}</Text>
        <Text dimColor>${usd.toFixed(2)} spent</Text>
      </Box>
    )

  return (
    <Box flexDirection="column">
      <Text bold color="#D97757">✳ Lead · Claude</Text>
      {windows.length === 0 && <Text dimColor>No reading yet: limits arrive with the first reply on a subscription.</Text>}
      {windows.map(w => row(leadLabel(w.kind), w.percentUsed, resetsIn(w.resetsAt, now)))}

      <Text bold>⌘ Heads · {engineLabel(hydra, defaultEngine)}</Text>
      <Text dimColor>{plan ? `Plan · ${plan} · ` : ''}estimated from local session costs</Text>
      {!usage && <Text dimColor>Reading Head usage…</Text>}
      {usage?.error && <Text color={isNoSpend(usage.error) ? undefined : 'red'} dimColor={isNoSpend(usage.error)} wrap="wrap">{usage.error}</Text>}
      {usage && !usage.error && spend('5-hour', usage.fiveHour.usd, fiveHourUsd, usage.fiveHour.resetsAt)}
      {usage && !usage.error && spend('Weekly', usage.weekly.usd, weeklyUsd, usage.weekly.resetsAt)}
      {usage && !usage.error && (fiveHourUsd <= 0 || weeklyUsd <= 0) && (
        <Box marginBottom={1}>
          <Text dimColor wrap="wrap">Set your Command Code plan's limits in /config (the Hydra rows) to see how close you are.</Text>
        </Box>
      )}

      {mix.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>This session</Text>
          {mix.map(item => (
            <Box key={`mix-${item.engine}`} justifyContent="space-between">
              <Text>{isEngine(item.engine) ? ENGINE_LABEL[item.engine] : item.engine}</Text>
              <Text dimColor>{[`${item.count} Head${item.count === 1 ? '' : 's'}`, item.tokens > 0 ? `${compactNumber(item.tokens)} tok` : '', item.hasUsd ? `$${item.usd.toFixed(4)}` : ''].filter(Boolean).join(' · ')}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Text bold>🐉 Hydra · {hydra?.isOn ? `on · Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)} · effort ${effortModeOf(hydra)}` : 'off'}</Text>
      {recent.length > 0 && <Text dimColor>{headsSummary(recent)} · /heads to watch them</Text>}
    </Box>
  )
}
