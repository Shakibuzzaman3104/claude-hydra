/**
 * @author Shakib
 * @since 25/11/26
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = resolve(HERE, 'dist')
const isCheck = process.argv.includes('--check')

const bundle = (entry, outfile) => {
  const built = spawnSync('npx', [
    '-y', 'esbuild@0.24.0', resolve(HERE, entry), '--bundle', '--format=esm', '--platform=node', '--target=node20', '--log-level=warning',
    `--alias:claude-code=${resolve(HERE, 'shim.ts')}`, `--outfile=${outfile}`,
  ], { cwd: ROOT, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

mkdirSync(DIST, { recursive: true })
const server = resolve(DIST, 'hydra-mcp.mjs')
const policyOut = resolve(DIST, '.policy.mjs')
const built = isCheck ? resolve(DIST, '.check.mjs') : server
bundle('main.ts', built)
bundle('policy-entry.ts', policyOut)
const { AGY_LEAD_POLICY } = await import(`${pathToFileURL(policyOut).href}?at=${Date.now()}`)
rmSync(policyOut)
const rules = `${AGY_LEAD_POLICY()}\n`
const rulesPath = resolve(ROOT, 'rules', 'AGENTS.md')

if (isCheck) {
  const same = readFileSync(built, 'utf8') === readFileSync(server, 'utf8') && readFileSync(rulesPath, 'utf8') === rules
  rmSync(built)
  if (!same) {
    console.error('agy/dist/hydra-mcp.mjs or rules/AGENTS.md is out of date: run node agy/build.mjs and commit the result.')
    process.exit(1)
  }
  console.log('agy build is up to date.')
} else {
  mkdirSync(dirname(rulesPath), { recursive: true })
  writeFileSync(rulesPath, rules)
  console.log(`Built ${server} and ${rulesPath}.`)
}
