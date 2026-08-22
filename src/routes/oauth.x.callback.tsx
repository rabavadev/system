import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { AlertCircle, ArrowLeft } from 'lucide-react'
import { z } from 'zod'

import { completeXOAuthCallbackFn } from '~/features/accounts/server'

const callbackSearchSchema = z.object({
  state: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

export const Route = createFileRoute('/oauth/x/callback')({
  validateSearch: (search) => callbackSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({
    state: search.state ?? null,
    code: search.code ?? null,
    error: search.error ?? null,
    errorDescription: search.error_description ?? null,
  }),
  loader: async ({ deps }) => {
    const result = await completeXOAuthCallbackFn({
      data: {
        state: deps.state,
        code: deps.code,
        error: deps.error,
        errorDescription: deps.errorDescription,
      },
    })

    if (result.ok) {
      throw redirect({
        to: '/accounts/$accountId',
        params: { accountId: result.accountId },
      })
    }

    return { result }
  },
  component: XOAuthCallbackPage,
})

function XOAuthCallbackPage() {
  const { result } = Route.useLoaderData()

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      <div className="flex flex-col items-center gap-4">
        <div className="flex size-12 items-center justify-center rounded-full bg-rose-100 text-rose-600">
          <AlertCircle className="size-6" />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-zinc-900">Connection Failed</h1>
          <p className="text-sm text-zinc-500">{result.reason}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/accounts"
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
          >
            <ArrowLeft className="size-4" />
            Back to Accounts
          </Link>
        </div>
      </div>
    </div>
  )
}
