/**
 * Small shared utilities. Keep this file dependency-free.
 */

/** Join conditional class names. */
export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}
