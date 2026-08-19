import { TriangleAlert } from 'lucide-react'

interface ErrorStateProps {
  error: unknown
  reset?: () => void
}

/**
 * Route-level error fallback. Error reporting hooks up here later; for now it
 * fails closed with a plain message and a retry.
 */
export function ErrorState({ error, reset }: ErrorStateProps) {
  const message = error instanceof Error ? error.message : 'Something went wrong.'

  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-6 py-12 text-center">
      <div className="flex size-9 items-center justify-center rounded-md bg-red-100 text-red-600">
        <TriangleAlert className="size-4.5" strokeWidth={1.75} />
      </div>
      <h2 className="text-sm font-medium text-zinc-900">This page hit a problem</h2>
      <p className="max-w-sm text-sm text-zinc-600">{message}</p>
      {reset ? (
        <button
          type="button"
          onClick={reset}
          className="mt-1 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}
