/**
 * Shared loading indicator for route pending states and suspense boundaries.
 */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-zinc-500" role="status">
      <span
        className="size-3.5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600"
        aria-hidden
      />
      <span className="sr-only">{label}</span>
    </div>
  )
}
