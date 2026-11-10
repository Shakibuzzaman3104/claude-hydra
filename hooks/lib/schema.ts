/**
 * @author Shakib
 * @since 11/11/26
 */

export type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; minItems?: number; maxItems?: number; description?: string; additionalProperties?: boolean }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const actualType = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const matchesType = (type: string, value: unknown): boolean => {
  if (type === 'object') return isPlainObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return false
}

const walk = (schema: Schema, value: unknown, path: string, errors: string[]): void => {
  if (errors.length >= 20) return
  const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types !== undefined && !types.some(type => matchesType(type, value))) {
    errors.push(`${path}: expected ${types.join(' or ')}, got ${actualType(value)}`)
    return
  }
  if (schema.enum !== undefined && !schema.enum.some(entry => entry === value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`)
    if (errors.length >= 20) return
  }
  if (isPlainObject(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
        errors.push(`${path}.${name}: missing`)
        if (errors.length >= 20) return
      }
    }
    const properties = schema.properties ?? {}
    for (const key of Object.keys(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) continue
      const child = properties[key]
      if (child === undefined) continue
      walk(child, value[key], `${path}.${key}`, errors)
      if (errors.length >= 20) return
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) continue
        errors.push(`${path}.${key}: not allowed`)
        if (errors.length >= 20) return
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} item(s)`)
      if (errors.length >= 20) return
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: takes at most ${schema.maxItems} item(s)`)
      if (errors.length >= 20) return
    }
    const itemSchema = schema.items
    if (itemSchema !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        walk(itemSchema, value[index], `${path}[${index}]`, errors)
        if (errors.length >= 20) return
      }
    }
  }
}

const fencedBlocks = (text: string): { lang: string; body: string }[] => {
  const blocks: { lang: string; body: string }[] = []
  let lang: string | undefined
  let body: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimStart()
    if (!line.startsWith('```')) {
      if (lang !== undefined) body.push(raw)
      continue
    }
    if (lang === undefined) {
      lang = line.slice(3)
      body = []
    } else {
      blocks.push({ lang, body: body.join('\n') })
      lang = undefined
      body = []
    }
  }
  return blocks
}

const matchBrace = (text: string, start: number): number => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const parseBlock = (body: string): { value: unknown } | { error: string } => {
  try {
    return { value: JSON.parse(body.trim()) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: `the JSON block does not parse: ${message.slice(0, 160)}` }
  }
}

const braceJson = (text: string): { value: unknown } | undefined => {
  const pairs: { start: number; end: number }[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue
    const end = matchBrace(text, index)
    if (end !== -1) pairs.push({ start: index, end })
  }
  const topLevel = pairs
    .filter(pair => !pairs.some(other => other.start < pair.start && other.end > pair.end))
    .sort((left, right) => right.start - left.start)
  for (const pair of topLevel) {
    try {
      return { value: JSON.parse(text.slice(pair.start, pair.end + 1)) }
    } catch {
      continue
    }
  }
  return undefined
}

export const schemaProblem = (schema: unknown): string | undefined => {
  if (!isPlainObject(schema)) return 'schema must be an object'
  if (schema.type !== 'object') return 'schema needs "type": "object" at its root'
  const properties = schema.properties
  if (!isPlainObject(properties) || Object.keys(properties).length === 0) return 'schema needs "properties"'
  const required = schema.required
  if (required !== undefined && (!Array.isArray(required) || required.some(name => typeof name !== 'string'))) return '"required" must be a list of property names'
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === 'string' && !Object.prototype.hasOwnProperty.call(properties, name)) return `"required" names "${name}", which is not in "properties"`
    }
  }
  if (JSON.stringify(schema).length > 6000) return 'schema is too large (over 6000 characters)'
  return undefined
}

/** Every way value breaks schema, as messages starting with the path. */
export const validate = (schema: Schema, value: unknown, path = '$'): string[] => {
  const errors: string[] = []
  walk(schema, value, path, errors)
  return errors.slice(0, 20)
}

/** The JSON value an agent put in its reply, or why there is none. */
export const extractJson = (text: string): { value: unknown } | { error: string } => {
  const blocks = fencedBlocks(text)
  const jsonBlocks = blocks.filter(block => /^json$/i.test(block.lang.trim()))
  const jsonBlock = jsonBlocks[jsonBlocks.length - 1]
  if (jsonBlock !== undefined) return parseBlock(jsonBlock.body)
  const fenced = blocks.filter(block => {
    const body = block.body.trim()
    return body.startsWith('{') || body.startsWith('[')
  })
  const fencedBlock = fenced[fenced.length - 1]
  if (fencedBlock !== undefined) return parseBlock(fencedBlock.body)
  const braced = braceJson(text)
  if (braced !== undefined) return braced
  return { error: 'no JSON block in the reply' }
}

/** The instruction that tells an agent to answer with matching JSON. */
export const schemaNote = (schema: Schema): string =>
  `\n\nAnswer format (required): put your result in ONE fenced \`\`\`json block near the end of your final reply, before the line that ends the run. It must be valid JSON that matches this schema; keep every string short and factual, and use file paths relative to the project. Anything you write outside that block is read by a person, not parsed.\n\n\`\`\`json-schema\n${JSON.stringify(schema, null, 1)}\n\`\`\``

/** The instruction that asks an agent to redo a reply with corrected JSON. */
export const schemaFixNote = (errors: readonly string[]): string =>
  `Your last reply did not carry a usable JSON result:\n${errors.slice(0, 10).map(line => `- ${line}`).join('\n')}\nReply again with the corrected \`\`\`json block (the whole result, not a patch) and end the run as before. Make no other changes.`

/** The reply's JSON data, or the reasons it is missing or invalid. */
export const readReply = (schema: Schema, text: string): { data: unknown } | { errors: string[] } => {
  const found = extractJson(text)
  if ('error' in found) return { errors: [found.error] }
  const errors = validate(schema, found.value)
  if (errors.length > 0) return { errors }
  return { data: found.value }
}
