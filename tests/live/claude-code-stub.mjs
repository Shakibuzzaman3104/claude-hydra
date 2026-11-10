/**
 * @author Shakib
 * @since 10/11/26
 */
const keyOf = source => `${source.ref.plugin}/${source.ref.key}`

export const atom = (ref, initial) => ({ ref, initial })

export const read = async ($, source) => ($.state.has(keyOf(source)) ? $.state.get(keyOf(source)) : source.initial)

export const update = async ($, source, change) => {
  const next = change(await read($, source))
  $.state.set(keyOf(source), next)
  return next
}
