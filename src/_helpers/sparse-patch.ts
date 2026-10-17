import isEqual from 'lodash/isEqual'

/**
 * Sparse storage helpers: keep only what differs from the defaults, and
 * rebuild the full value by laying that patch back over fresh defaults.
 * Plain objects are diffed key by key; arrays and primitives are all-or-nothing.
 */

/** Patch key listing default keys the value no longer has (e.g. a deleted context menu). */
const DELETED = '$deleted'

export function diffValue(value: any, baseValue: any): any {
  if (!isPlainObject(value) || !isPlainObject(baseValue)) {
    return isEqual(value, baseValue) ? undefined : value
  }

  const result = {}
  const deleted = Object.keys(baseValue).filter(key => !(key in value))
  if (deleted.length > 0) {
    result[DELETED] = deleted
  }
  Object.keys(value).forEach(key => {
    const diff = diffValue(value[key], baseValue[key])
    if (diff !== undefined) {
      result[key] = diff
    }
  })

  return Object.keys(result).length > 0 ? result : undefined
}

/** Inverse of `diffValue`. Mutates and returns `base`. */
export function applyPatch<T>(base: T, patch: any): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch
  }
  Object.keys(patch).forEach(key => {
    if (key === DELETED) {
      patch[key].forEach((k: string) => delete base[k])
    } else {
      base[key] = applyPatch(base[key], patch[key])
    }
  })
  return base
}

export function isPlainObject(value: any): value is { [key: string]: any } {
  return Object.prototype.toString.call(value) === '[object Object]'
}
