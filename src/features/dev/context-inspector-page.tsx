import { useState } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import type { ContextPackage } from '~/server/context'

import { type DevContextOptions, type DevContextResult, getDevContextPackage } from './server'

/**
 * Development-only Context Inspector. Exists to verify the Context Engine
 * before any AI is connected. Not linked from navigation; the route
 * renders NotFound outside development builds. Nothing here is a normal
 * user feature.
 */

interface Selection {
  brandId: string
  productId: string
  accountId: string
  conversationId: string
  useUiBrand: boolean
  taskText: string
}

const EMPTY: Selection = {
  brandId: '',
  productId: '',
  accountId: '',
  conversationId: '',
  useUiBrand: false,
  taskText: '',
}

const selectClass =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900'
const labelClass = 'mb-1 block text-xs font-medium text-zinc-500'

export function ContextInspectorPage({ options }: { options: DevContextOptions }) {
  const [selection, setSelection] = useState<Selection>(EMPTY)
  const [result, setResult] = useState<DevContextResult | null>(null)
  const [unexpectedError, setUnexpectedError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function run() {
    setPending(true)
    setUnexpectedError(null)
    try {
      const response = await getDevContextPackage({
        data: {
          ...(selection.brandId ? { brandId: selection.brandId } : {}),
          ...(selection.productId ? { productId: selection.productId } : {}),
          ...(selection.accountId ? { accountId: selection.accountId } : {}),
          ...(selection.conversationId ? { conversationId: selection.conversationId } : {}),
          useUiBrand: selection.useUiBrand,
          ...(selection.taskText ? { taskText: selection.taskText } : {}),
        },
      })
      setResult(response)
    } catch (error) {
      // Validation or transport failures reject before a DevContextResult
      // exists; surface them instead of failing silently.
      setResult(null)
      setUnexpectedError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Context Inspector"
        description="Developer tool: inspect what the Context Engine resolves for a given request."
      />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        Development only. Ids and engine internals are shown intentionally; this page is never
        linked for normal users and renders NotFound in production builds.
      </div>

      <div className="grid grid-cols-1 gap-4 rounded-lg border border-zinc-200 bg-white p-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ci-conversation" className={labelClass}>
            Conversation
          </label>
          <select
            id="ci-conversation"
            className={selectClass}
            value={selection.conversationId}
            onChange={(e) => setSelection({ ...selection, conversationId: e.target.value })}
          >
            <option value="">— none —</option>
            {options.conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ci-brand" className={labelClass}>
            Explicit brand
          </label>
          <select
            id="ci-brand"
            className={selectClass}
            value={selection.brandId}
            onChange={(e) => setSelection({ ...selection, brandId: e.target.value })}
          >
            <option value="">— none —</option>
            {options.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ci-product" className={labelClass}>
            Explicit product
          </label>
          <select
            id="ci-product"
            className={selectClass}
            value={selection.productId}
            onChange={(e) => setSelection({ ...selection, productId: e.target.value })}
          >
            <option value="">— none —</option>
            {options.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ci-account" className={labelClass}>
            Explicit account
          </label>
          <select
            id="ci-account"
            className={selectClass}
            value={selection.accountId}
            onChange={(e) => setSelection({ ...selection, accountId: e.target.value })}
          >
            <option value="">— none —</option>
            {options.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={selection.useUiBrand}
            onChange={(e) => setSelection({ ...selection, useUiBrand: e.target.checked })}
          />
          Include current UI brand selection (cookie)
        </label>
        <div>
          <label htmlFor="ci-task" className={labelClass}>
            Task text (optional)
          </label>
          <input
            id="ci-task"
            className={selectClass}
            value={selection.taskText}
            maxLength={500}
            onChange={(e) => setSelection({ ...selection, taskText: e.target.value })}
            placeholder="e.g. draft a post for this product"
          />
        </div>
        <div className="sm:col-span-2">
          <button
            type="button"
            onClick={run}
            disabled={pending}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            {pending ? 'Building…' : 'Build context'}
          </button>
        </div>
      </div>

      {unexpectedError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="font-medium">unexpected_error</span> — {unexpectedError}
        </div>
      )}

      {result && !result.ok && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="font-medium">{result.error.code}</span> — {result.error.message}
        </div>
      )}

      {result?.ok && <PackageView pkg={result.package} />}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-28 shrink-0 text-zinc-400">{label}</span>
      <span className="text-zinc-900">{value ?? '—'}</span>
    </div>
  )
}

function PackageView({ pkg }: { pkg: ContextPackage }) {
  return (
    <div className="flex flex-col gap-4">
      <Section title="Resolution">
        <Row label="Workspace" value={`${pkg.workspace.name} (${pkg.workspace.id})`} />
        <Row
          label="Active scope"
          value={
            pkg.activeScope.id ? `${pkg.activeScope.type}: ${pkg.activeScope.id}` : 'workspace'
          }
        />
        <Row label="Scope source" value={pkg.scopeSource} />
        <Row label="Generated at" value={pkg.generatedAt} />
      </Section>

      {pkg.brand && (
        <Section title="Brand">
          <Row label="Name" value={pkg.brand.name} />
          <Row label="Id" value={pkg.brand.id} />
        </Section>
      )}

      {pkg.niche && (
        <Section title="Niche">
          <Row label="Name" value={pkg.niche.name} />
          <Row label="Id" value={pkg.niche.id} />
        </Section>
      )}

      {pkg.product && (
        <Section title="Product">
          <Row label="Name" value={pkg.product.name} />
          <Row label="Status" value={pkg.product.status} />
          <Row label="Id" value={pkg.product.id} />
        </Section>
      )}

      {pkg.account && (
        <Section title="Account">
          <Row label="Handle" value={pkg.account.displayName ?? pkg.account.handle} />
          <Row label="Platform" value={pkg.account.platform.name} />
          <Row label="Connection" value={pkg.account.platform.connectionStatus ?? 'none'} />
          <Row label="Id" value={pkg.account.id} />
        </Section>
      )}

      {pkg.campaign && (
        <Section title="Campaign">
          <Row label="Name" value={pkg.campaign.name} />
          <Row label="Status" value={pkg.campaign.status} />
        </Section>
      )}

      {pkg.conversation && (
        <Section title="Conversation">
          <Row label="Title" value={pkg.conversation.title ?? 'Untitled'} />
          <Row
            label="Persisted scope"
            value={
              pkg.conversation.scopeType
                ? `${pkg.conversation.scopeType}: ${pkg.conversation.scopeId}`
                : 'none (general)'
            }
          />
        </Section>
      )}

      <Section title={`Recent messages (${pkg.recentMessages.length})`}>
        {pkg.recentMessages.length === 0 ? (
          <p className="text-sm text-zinc-400">No messages.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {pkg.recentMessages.map((m) => (
              <li key={m.id} className="text-sm">
                <span className="font-medium text-zinc-500">{m.senderType}:</span>{' '}
                <span className="text-zinc-900">{m.content}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Memory (${pkg.memories.length})`}>
        {pkg.memories.length === 0 ? (
          <p className="text-sm text-zinc-400">No memories in scope.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {pkg.memories.map((m) => (
              <li key={m.id} className="text-sm text-zinc-900">
                <span className="mr-1 rounded bg-zinc-100 px-1 text-xs text-zinc-500">
                  {m.memoryClass} · {m.authority} · {m.scopeType}
                </span>
                {m.content}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Research (${pkg.research.length})`}>
        {pkg.research.length === 0 ? (
          <p className="text-sm text-zinc-400">No research in scope.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {pkg.research.map((r) => (
              <li key={r.id} className="text-sm text-zinc-900">
                <span
                  className={`mr-1 rounded px-1 text-xs ${
                    r.freshness === 'current'
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-amber-50 text-amber-700'
                  }`}
                >
                  {r.freshness}
                </span>
                {r.subject}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Goals (${pkg.goals.length})`}>
        {pkg.goals.length === 0 ? (
          <p className="text-sm text-zinc-400">No active goals in scope.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {pkg.goals.map((g) => (
              <li key={g.id} className="text-sm text-zinc-900">
                <span className="mr-1 rounded bg-zinc-100 px-1 text-xs text-zinc-500">
                  {g.scopeType}
                </span>
                {g.title}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Context trace (${pkg.trace.entries.length} entries)`}>
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {pkg.trace.entries.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: trace entries have no unique id; the list is static per render.
            <li key={`${entry.targetType}-${entry.targetId}-${index}`} className="flex gap-2">
              <span
                className={`w-20 shrink-0 font-semibold ${
                  entry.action === 'included'
                    ? 'text-emerald-600'
                    : entry.action === 'excluded'
                      ? 'text-red-500'
                      : entry.action === 'precedence'
                        ? 'text-amber-600'
                        : 'text-zinc-400'
                }`}
              >
                {entry.action}
              </span>
              <span className="w-24 shrink-0 text-zinc-500">{entry.targetType}</span>
              <span className="text-zinc-900">
                {entry.label ? `${entry.label} — ` : ''}
                {entry.reason}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}
