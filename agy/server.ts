/**
 * @author Shakib
 * @since 25/11/26
 */
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import type { EngineInterface } from 'claude-code'

import type { HydraMode } from '../types'
import { runControl } from '../hooks/lib/control'
import { AUTO, DEFAULT_ENGINE, ENGINES, isEngine } from '../hooks/lib/engines'
import type { Engine } from '../hooks/lib/engines'
import { parseHunt } from '../hooks/lib/hunt'
import { huntControllers, prepareHead, runHuntJob, runStructured, sweepHunts, vetHunt } from '../hooks/lib/launch'
import type { Launch } from '../hooks/lib/launch'
import { CHECK_CONSENT_KEY, consentKey, controllers, hasConsent, hasConsentAll, readyEngines } from '../hooks/lib/runtime'
import { schemaProblem } from '../hooks/lib/schema'
import type { Schema } from '../hooks/lib/schema'
import { readMode, updateMode } from '../hooks/lib/state'
import { CONTROL_TOOL_DEF, HEAD_TOOL_DEF, HUNT_TOOL_DEF } from '../hooks/lib/tools'
import { JsonFile, createRuntime } from './runtime'

const VERSION = '2.5.0'
const DEFAULT_HEAD = 'deepseek/deepseek-v4.1-flash'
const LAUNCH: Launch = { defaultEngine: DEFAULT_ENGINE, defaultHead: DEFAULT_HEAD, isFallbackOn: true }
const BACKGROUND_NOTE = 'Antigravity runs this call in the background and hands you the result when it ends, so start several and keep working.'

type Message = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }
type ToolDef = { name: string; description: string; inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] } }

/** One folder for every agy session and the `--consent` command: plugin updates and reinstalls keep it. */
export const dataDir = process.env.HYDRA_DATA || resolve(homedir(), '.gemini', 'hydra')
const pluginRoot = process.env.PLUGIN_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The agy tools: the Claude Code tools without `background`, which Antigravity decides per tool. */
export const agyTools = (): ToolDef[] => [HEAD_TOOL_DEF, HUNT_TOOL_DEF, CONTROL_TOOL_DEF].map(def => {
  const tool = def as unknown as ToolDef
  const { background: _background, ...properties } = tool.inputSchema.properties ?? {}
  const description = tool.description
    .replace(/;? ?with background: true it returns at once and the report arrives as a message\./, '.')
    .replace(/ Usable only while the person has Hydra on\./, '')
  return { ...tool, description: tool.name === 'control' ? description : `${description} ${BACKGROUND_NOTE}`, inputSchema: { ...tool.inputSchema, properties } }
})

/** `--consent codex,commandcode` and `--checks`: agree ahead of time, for headless agy where no form can be shown. */
export function consentFromArgs(argv: readonly string[], store: JsonFile): string | undefined {
  const index = argv.indexOf('--consent')
  const checks = argv.includes('--checks')
  if (index < 0 && !checks) return undefined
  const named = index >= 0 ? String(argv[index + 1] ?? '').split(',').map(name => name.trim()).filter(Boolean) : []
  const bad = named.filter(name => !isEngine(name))
  if (bad.length > 0) return `Unknown engine(s): ${bad.join(', ')}. Engines: ${ENGINES.join(', ')}.`
  for (const engine of named as Engine[]) store.set(consentKey(engine), true)
  if (checks) store.set(CHECK_CONSENT_KEY, true)
  return `Hydra for Antigravity: ${[named.length ? `code may go to ${named.join(', ')}` : '', checks ? 'checks may run' : ''].filter(Boolean).join('; ')}. Saved in ${dataDir}.`
}

/** Turns Hydra on in auto mode the first time the Lead uses it: the ready engines it has consent for, asking once for the rest. */
async function ensureOn($: EngineInterface): Promise<HydraMode | { deny: string }> {
  const stored = await readMode($)
  if (stored?.isOn) return stored
  if (stored && !stored.isOn) return { deny: 'Hydra is off. Turn it back on with the control tool (action: "on").' }
  const ready = await readyEngines($, ENGINES)
  if (ready.pool.length === 0) return { deny: `No Head engine is ready on this machine: ${ready.skipped.map(item => `${item.engine}: ${item.problem}`).join('; ')}` }
  const agreed: Engine[] = []
  for (const engine of ready.pool) if (await hasConsent($, DEFAULT_HEAD, false, engine)) agreed.push(engine)
  const pool = agreed.length > 0 ? agreed : (await hasConsentAll($, ready.pool, true)) ? ready.pool : []
  if (pool.length === 0) {
    return { deny: `The person has not agreed to send code to any engine (ready here: ${ready.pool.join(', ')}). They agree in the form Antigravity shows, or ahead of time with: node "${pluginRoot}/agy/dist/hydra-mcp.mjs" --consent ${ready.pool.join(',')} --checks` }
  }
  return (await updateMode($, () => ({ isOn: true, headModel: DEFAULT_HEAD, effort: 'auto', engine: AUTO, engines: pool })))!
}

export async function callHead($: EngineInterface, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError?: boolean }> {
  const hydra = await ensureOn($)
  if ('deny' in hydra) return { text: hydra.deny, isError: true }
  const schemaFault = args.schema === undefined || args.schema === null ? undefined : schemaProblem(args.schema)
  if (schemaFault) return { text: `\`schema\`: ${schemaFault}.`, isError: true }
  const { schema, background: _background, ...asked } = args
  const prepared = await prepareHead($, hydra, asked, LAUNCH)
  if ('deny' in prepared) return { text: prepared.deny, isError: true }
  const controller = new AbortController()
  const stop = () => controller.abort(signal.reason)
  signal.addEventListener('abort', stop, { once: true })
  controllers.set(prepared.id, controller)
  try {
    const { result } = await runStructured($, prepared, controller.signal, (schema as Schema | undefined) ?? prepared.schema)
    return { text: result.text }
  } finally {
    controllers.delete(prepared.id)
    signal.removeEventListener('abort', stop)
  }
}

export async function callHunt($: EngineInterface, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError?: boolean }> {
  const hydra = await ensureOn($)
  if ('deny' in hydra) return { text: hydra.deny, isError: true }
  const parsed = parseHunt(args, await $.session.root())
  if ('deny' in parsed) return { text: parsed.deny, isError: true }
  const { plan } = parsed
  if (huntControllers.has(plan.name)) return { text: `A hunt named "${plan.name}" is still running. Wait for it, stop it with control (id: "${plan.name}"), or pick another name.`, isError: true }
  const vetted = await vetHunt($, hydra, plan, LAUNCH.defaultEngine)
  if ('deny' in vetted) return { text: vetted.deny, isError: true }
  const notes = [...(parsed.notes ?? []), ...vetted.notes]
  const controller = new AbortController()
  const stop = () => controller.abort(signal.reason)
  signal.addEventListener('abort', stop, { once: true })
  huntControllers.set(plan.name, controller)
  try {
    const text = await runHuntJob($, { plan, launch: LAUNCH }, controller.signal)
    return { text: [text, ...notes].join('\n') }
  } finally {
    huntControllers.delete(plan.name)
    signal.removeEventListener('abort', stop)
  }
}

export async function callControl($: EngineInterface, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  if ((await readMode($)) === null && (args.action === undefined || args.action === 'list')) {
    const ready = await readyEngines($, ENGINES)
    return { text: `Hydra not started yet in this conversation: the first head or hunt call turns it on.\nEngines ready here: ${ready.pool.join(', ') || 'none'}${ready.skipped.length ? `\nNot ready: ${ready.skipped.map(item => `${item.engine} (${item.problem})`).join('; ')}` : ''}` }
  }
  const outcome = await runControl($, args, { defaultEngine: DEFAULT_ENGINE, defaultHead: DEFAULT_HEAD, defaultEffort: 'auto', isAutoDefault: true })
  return 'deny' in outcome ? { text: outcome.deny, isError: true } : { text: outcome.result }
}

/** One stdio MCP session: answers Antigravity's requests and asks it for consent through elicitation forms. */
export function serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
  let sessionId = `agy-${process.pid}`
  let elicit = false
  let nextAsk = 0
  const asks = new Map<string, (answer: Message) => void>()
  const calls = new Map<string | number, AbortController>()
  const send = (message: Message) => output.write(`${JSON.stringify(message)}\n`)

  const ask = (question: string, options: { options: string[]; header?: string }) => {
    if (!elicit) return Promise.resolve(undefined)
    const id = `hydra-ask-${++nextAsk}`
    return new Promise<string | undefined>(done => {
      asks.set(id, answer => {
        const content = (answer.result as { action?: string; content?: { choice?: unknown } } | undefined)
        done(content?.action === 'accept' && typeof content.content?.choice === 'string' ? content.content.choice : undefined)
      })
      send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message: question, requestedSchema: { type: 'object', properties: { choice: { type: 'string', title: options.header ?? 'Hydra', enum: options.options } }, required: ['choice'] } } })
    })
  }

  const $ = createRuntime({ dataDir, pluginRoot, workspace: process.cwd(), sessionId: () => sessionId, ask }) as unknown as EngineInterface

  const handle = async (message: Message) => {
    if (message.id !== undefined && !message.method) {
      asks.get(String(message.id))?.(message)
      asks.delete(String(message.id))
      return
    }
    const params = message.params ?? {}
    switch (message.method) {
      case 'initialize': {
        elicit = Boolean((params.capabilities as { elicitation?: unknown } | undefined)?.elicitation)
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hydra-heads', version: VERSION } } })
        void sweepHunts($).catch(() => undefined)
        return
      }
      case 'tools/list':
        send({ jsonrpc: '2.0', id: message.id, result: { tools: agyTools() } })
        return
      case 'tools/call': {
        const meta = (params._meta ?? {}) as Record<string, unknown>
        const conversation = meta['antigravity.google/root_conversation_id'] ?? meta['antigravity.google/conversation_id']
        if (typeof conversation === 'string' && conversation && sessionId.startsWith('agy-')) sessionId = conversation
        const controller = new AbortController()
        calls.set(message.id!, controller)
        const args = (params.arguments ?? {}) as Record<string, unknown>
        try {
          const outcome = params.name === 'head' ? await callHead($, args, controller.signal)
            : params.name === 'hunt' ? await callHunt($, args, controller.signal)
            : params.name === 'control' ? await callControl($, args)
            : { text: `Unknown tool ${String(params.name)}.`, isError: true }
          send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) } })
        } catch (error) {
          send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `Hydra: the call failed (${String(error).slice(0, 300)}).` }], isError: true } })
        } finally {
          calls.delete(message.id!)
        }
        return
      }
      case 'notifications/cancelled':
        calls.get(params.requestId as string | number)?.abort('cancelled by Antigravity')
        return
      default:
        if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: `Method not found: ${message.method}` } }) })
    }
  }

  createInterface({ input }).on('line', line => {
    if (!line.trim()) return
    let message: Message
    try { message = JSON.parse(line) } catch { return }
    void handle(message)
  })
  input.on('end', () => {
    for (const controller of [...calls.values(), ...controllers.values(), ...huntControllers.values()]) controller.abort('Antigravity closed the session')
  })
}
