import { useRouter } from '@tanstack/react-router'
import { AlertCircle, FlaskConical, Globe, X } from 'lucide-react'
import { useEffect, useState, useTransition } from 'react'
import { Button } from '~/components/ui/button'
import type { Message } from '~/types/domain'
import {
  createResearchFn,
  deriveResearchTitle,
  getResearchScopeOptionsFn,
  RESEARCH_STATUS_LABELS,
  RESEARCH_STATUSES,
  RESEARCH_TYPE_LABELS,
  RESEARCH_TYPES,
  type ResearchScopeOptions,
  type ResearchScopeType,
  type ResearchStatus,
  type ResearchType,
} from './server'

export interface SaveResearchDialogProps {
  message: Message
  conversationScope?:
    | {
        scopeType: string | null
        scopeId: string | null
      }
    | undefined
  derivedFromResearchIds?: string[] | undefined
  onClose: () => void
  onSaved?: ((researchId: string) => void) | undefined
}

interface SearchSourceItem {
  title: string
  url: string
  publisher?: string | null | undefined
  publishedAt?: string | null | undefined
  retrievedAt?: string | undefined
}

function deriveSuggestedType(scopeType?: string | null): ResearchType {
  if (scopeType === 'product') return 'product'
  if (scopeType === 'brand') return 'market'
  if (scopeType === 'account') return 'competitor'
  return 'general'
}

export function SaveResearchDialog({
  message,
  conversationScope,
  derivedFromResearchIds,
  onClose,
  onSaved,
}: SaveResearchDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [scopeOptions, setScopeOptions] = useState<ResearchScopeOptions>({
    brands: [],
    niches: [],
    products: [],
    accounts: [],
    campaigns: [],
  })

  // Extract available genuine search sources from assistant message metadata
  const availableSources: SearchSourceItem[] = (() => {
    if (!message.providerMetadataJson) return []
    try {
      const meta = JSON.parse(message.providerMetadataJson)
      if (Array.isArray(meta?.sources) && meta.sources.length > 0) {
        return meta.sources.filter((s: unknown): s is SearchSourceItem =>
          Boolean(
            s &&
              typeof s === 'object' &&
              typeof (s as { url?: unknown; title?: unknown }).url === 'string' &&
              typeof (s as { url?: unknown; title?: unknown }).title === 'string',
          ),
        )
      }
    } catch {
      return []
    }
    return []
  })()

  const [selectedSourceIndices, setSelectedSourceIndices] = useState<number[]>(() =>
    availableSources.map((_, i) => i),
  )

  // Prefill state deterministically
  const [subject, setSubject] = useState(() => deriveResearchTitle(message.content))
  const [findings, setFindings] = useState(() => message.content)
  const [researchType, setResearchType] = useState<ResearchType>(() =>
    deriveSuggestedType(conversationScope?.scopeType),
  )
  const [status, setStatus] = useState<ResearchStatus>('draft')
  const [confidence, setConfidence] = useState<string>('0.8')
  const [scopeType, setScopeType] = useState<ResearchScopeType | 'workspace'>(
    () => (conversationScope?.scopeType as ResearchScopeType) ?? 'workspace',
  )
  const [scopeId, setScopeId] = useState<string>(() => conversationScope?.scopeId ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getResearchScopeOptionsFn()
      .then((opts) => {
        if (active) setScopeOptions(opts)
      })
      .catch(() => {
        // Fallback silently if scope fetch fails
      })
    return () => {
      active = false
    }
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!subject.trim()) {
      setError('Title / Subject is required.')
      return
    }

    const confVal = confidence ? Number.parseFloat(confidence) : null
    if (confVal !== null && (Number.isNaN(confVal) || confVal < 0 || confVal > 1)) {
      setError('Confidence must be a number between 0.0 and 1.0')
      return
    }

    setError(null)
    startTransition(async () => {
      try {
        const created = await createResearchFn({
          data: {
            subject: subject.trim(),
            findings: findings.trim() || null,
            researchType,
            status,
            confidence: confVal,
            scopeType: scopeType === 'workspace' ? null : scopeType,
            scopeId: scopeType === 'workspace' || !scopeId ? null : scopeId,
            sourceMessageId: message.id,
            selectedSourceIndices: availableSources.length > 0 ? selectedSourceIndices : undefined,
            origin: {
              ...(derivedFromResearchIds && derivedFromResearchIds.length > 0
                ? { derivedFromResearchIds }
                : {}),
            },
          },
        })

        router.invalidate()
        onSaved?.(created.id)
        onClose()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save research finding.')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Save as Research"
        className="w-full max-w-xl rounded-xl border border-zinc-200 bg-white shadow-xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-blue-50 p-1.5 text-blue-600">
              <FlaskConical className="size-4" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-900">Save as Research</h2>
              <p className="text-xs text-zinc-500">
                Review and save AI finding as a draft research record.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Form Body */}
        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-4 text-xs"
        >
          {/* Informational banner about Draft default */}
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-900">
            <AlertCircle className="size-4 shrink-0 text-amber-600 mt-0.5" />
            <div>
              <span className="font-semibold">Review & Safety: </span>
              AI findings are saved as <strong className="font-semibold">Draft</strong> by default.
              Drafts remain excluded from active Context Engine prompts until you verify and promote
              them.
            </div>
          </div>

          {error && (
            <div className="rounded bg-red-50 p-2.5 text-red-800 border border-red-200">
              {error}
            </div>
          )}

          {/* Title */}
          <div className="space-y-1">
            <label htmlFor="save-res-title" className="font-medium text-zinc-700">
              Title / Subject <span className="text-red-500">*</span>
            </label>
            <input
              id="save-res-title"
              type="text"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Organic Search Trend Analysis"
              className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
            />
          </div>

          {/* Type & Status */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="save-res-type" className="font-medium text-zinc-700">
                Research Type
              </label>
              <select
                id="save-res-type"
                value={researchType}
                onChange={(e) => setResearchType(e.target.value as ResearchType)}
                className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              >
                {RESEARCH_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {RESEARCH_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="save-res-status" className="font-medium text-zinc-700">
                Status (Defaults to Draft)
              </label>
              <select
                id="save-res-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as ResearchStatus)}
                className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              >
                {RESEARCH_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {RESEARCH_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Scope selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="save-res-scope-type" className="font-medium text-zinc-700">
                Scope
              </label>
              <select
                id="save-res-scope-type"
                value={scopeType}
                onChange={(e) => {
                  const val = e.target.value as ResearchScopeType | 'workspace'
                  setScopeType(val)
                  setScopeId('')
                }}
                className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              >
                <option value="workspace">Workspace (All brands)</option>
                <option value="brand">Brand</option>
                <option value="niche">Niche</option>
                <option value="product">Product</option>
                <option value="account">Account</option>
                <option value="campaign">Campaign</option>
              </select>
            </div>

            {scopeType !== 'workspace' && (
              <div className="space-y-1">
                <label htmlFor="save-res-scope-id" className="font-medium text-zinc-700">
                  Target {scopeType.charAt(0).toUpperCase() + scopeType.slice(1)}
                </label>
                <select
                  id="save-res-scope-id"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
                >
                  <option value="">Select a target...</option>
                  {scopeType === 'brand' &&
                    scopeOptions.brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  {scopeType === 'niche' &&
                    scopeOptions.niches.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  {scopeType === 'product' &&
                    scopeOptions.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  {scopeType === 'account' &&
                    scopeOptions.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  {scopeType === 'campaign' &&
                    (scopeOptions.campaigns ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>

          {/* Confidence */}
          <div className="space-y-1">
            <label htmlFor="save-res-confidence" className="font-medium text-zinc-700">
              Confidence (0.0 to 1.0)
            </label>
            <input
              id="save-res-confidence"
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
              className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
            />
          </div>

          {/* Findings Textarea */}
          <div className="space-y-1">
            <label htmlFor="save-res-findings" className="font-medium text-zinc-700">
              Findings / Content
            </label>
            <textarea
              id="save-res-findings"
              rows={8}
              value={findings}
              onChange={(e) => setFindings(e.target.value)}
              placeholder="Detailed findings and insights..."
              className="w-full rounded-md border border-zinc-300 p-2 text-xs font-mono text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
            />
          </div>

          {/* Genuine Search Sources Selection (if available) */}
          {availableSources.length > 0 && (
            <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium text-zinc-900 flex items-center gap-1.5">
                  <Globe className="size-3.5 text-blue-600" />
                  <span>Sources found during this research ({availableSources.length})</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedSourceIndices(availableSources.map((_, i) => i))}
                    className="text-[11px] font-medium text-blue-600 hover:text-blue-700 hover:underline"
                  >
                    Select all
                  </button>
                  <span className="text-zinc-300">|</span>
                  <button
                    type="button"
                    onClick={() => setSelectedSourceIndices([])}
                    className="text-[11px] font-medium text-zinc-500 hover:text-zinc-700 hover:underline"
                  >
                    Deselect all
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-zinc-500">
                Selected findings will be attached as verified website citations on this research
                record.
              </p>
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {availableSources.map((s, idx) => {
                  const isChecked = selectedSourceIndices.includes(idx)
                  return (
                    <label
                      key={`source-${s.url}-${s.title}`}
                      className="flex items-start gap-2 rounded-md border border-zinc-200/80 bg-white p-2 hover:bg-zinc-50/80 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedSourceIndices((prev) => [...prev, idx])
                          } else {
                            setSelectedSourceIndices((prev) => prev.filter((i) => i !== idx))
                          }
                        }}
                        className="mt-0.5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-zinc-900 truncate">{s.title || s.url}</div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500 mt-0.5">
                          {s.publisher && (
                            <span className="font-medium text-zinc-700">{s.publisher}</span>
                          )}
                          {s.publishedAt && <span>• {s.publishedAt}</span>}
                          <span className="truncate text-zinc-400 font-mono text-[10px] max-w-full">
                            {s.url}
                          </span>
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {/* Footer buttons */}
          <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-100">
            <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isPending}>
              {isPending ? 'Saving...' : 'Save Draft Research'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
