/**
 * @author Shakib
 * @since 25/11/26
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), 'dist', 'hydra-mcp.mjs')

const session = data => {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, HYDRA_DATA: data, PATH: '' }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
  })
  let id = 0
  const request = (method, params = {}) => new Promise(done => {
    waiting.set(++id, done)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  return { request, close: () => child.kill() }
}

test('lists head, hunt and control without the background field', async () => {
  const data = mkdtempSync(join(tmpdir(), 'hydra-agy-'))
  const mcp = session(data)
  try {
    const init = await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} })
    assert.equal(init.result.serverInfo.name, 'hydra-heads')
    const { result } = await mcp.request('tools/list')
    assert.deepEqual(result.tools.map(tool => tool.name), ['head', 'hunt', 'control'])
    for (const tool of result.tools) assert.equal(tool.inputSchema.properties.background, undefined)
    assert.match(result.tools[0].description, /Antigravity runs this call in the background/)
    assert.doesNotMatch(result.tools[0].description, /arrives as a message/)
  } finally {
    mcp.close()
    rmSync(data, { recursive: true, force: true })
  }
})

test('control before the first Head says Hydra has not started, and an unknown method errors', async () => {
  const data = mkdtempSync(join(tmpdir(), 'hydra-agy-'))
  const mcp = session(data)
  try {
    await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} })
    const listed = await mcp.request('tools/call', { name: 'control', arguments: { action: 'list' }, _meta: { 'antigravity.google/root_conversation_id': 'conv-1' } })
    assert.match(listed.result.content[0].text, /Hydra not started yet/)
    const missing = await mcp.request('resources/list')
    assert.equal(missing.error.code, -32601)
  } finally {
    mcp.close()
    rmSync(data, { recursive: true, force: true })
  }
})

test('a head call with no engine ready is refused with the reason, not run', async () => {
  const data = mkdtempSync(join(tmpdir(), 'hydra-agy-'))
  const mcp = session(data)
  try {
    await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} })
    const refused = await mcp.request('tools/call', { name: 'head', arguments: { task: 'x', engine: 'codex' } })
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /No Head engine is ready|has not agreed/)
  } finally {
    mcp.close()
    rmSync(data, { recursive: true, force: true })
  }
})

test('--consent saves engine and check consent, and refuses unknown engines', () => {
  const data = mkdtempSync(join(tmpdir(), 'hydra-agy-'))
  try {
    const saved = spawnSync(process.execPath, [SERVER, '--consent', 'codex,commandcode', '--checks'], { env: { ...process.env, HYDRA_DATA: data }, encoding: 'utf8' })
    assert.match(saved.stdout, /code may go to codex, commandcode; checks may run/)
    const store = JSON.parse(readFileSync(join(data, 'store.json'), 'utf8'))
    assert.equal(Object.values(store).filter(value => value === true).length, 3)
    const bad = spawnSync(process.execPath, [SERVER, '--consent', 'nope'], { env: { ...process.env, HYDRA_DATA: data }, encoding: 'utf8' })
    assert.match(bad.stdout, /Unknown engine\(s\): nope/)
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})
