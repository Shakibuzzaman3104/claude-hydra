/**
 * @author Shakib
 * @since 25/11/26
 */
type Source<T> = { ref: { plugin: string; key: string; id?: string }; initial: T }
type WithState = { state: { has(key: string): boolean; get(key: string): unknown; set(key: string, value: unknown): void } }

const keyOf = (source: Source<unknown>) => `${source.ref.plugin}/${source.ref.key}${source.ref.id ? `/${source.ref.id}` : ''}`

/** `atom`, `read` and `update` from Claude Code's plugin runtime, over the agy runtime's session state. */
export const atom = <T>(ref: Source<T>['ref'], initial: T): Source<T> => ({ ref, initial })

export const read = async <T>($: WithState, source: Source<T>): Promise<T> => ($.state.has(keyOf(source)) ? ($.state.get(keyOf(source)) as T) : source.initial)

let chain: Promise<unknown> = Promise.resolve()

/** Serialised, so Heads finishing together never lose each other's run updates. */
export const update = <T>($: WithState, source: Source<T>, change: (value: T) => T): Promise<T> => {
  const next = chain.then(async () => {
    const value = change(await read($, source))
    $.state.set(keyOf(source), value)
    return value
  })
  chain = next.catch(() => undefined)
  return next
}
