import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  BookOpen,
  Bot,
  Edit3,
  ExternalLink,
  FileText,
  FlaskConical,
  GitCompare,
  Globe,
  Layers,
  Link2,
  Package,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
  Users,
  X,
} from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/empty-state'
import type { Freshness } from '~/server/context/types'
import {
  MAX_RESEARCH_ANALYSIS_SELECTION,
  MIN_RESEARCH_ANALYSIS_SELECTION,
  type ProvenanceStatus,
  RESEARCH_ANALYSIS_MODES,
  RESEARCH_SOURCE_TYPES,
  RESEARCH_STATUSES,
  RESEARCH_TYPES,
  type ResearchAnalysisMode,
  type ResearchScopeType,
  type ResearchSourceRecord,
  type ResearchSourceType,
  type ResearchStatus,
  type ResearchType,
} from '~/server/db/research'

import {
  addResearchSourceFn,
  archiveResearchFn,
  createResearchFn,
  listResearchOverview,
  RESEARCH_ANALYSIS_MODE_LABELS,
  RESEARCH_SOURCE_TYPE_LABELS,
  RESEARCH_STATUS_LABELS,
  RESEARCH_TYPE_LABELS,
  type ResearchListItem,
  removeResearchSourceFn,
  restoreResearchFn,
  startResearchAnalysisChatFn,
  startResearcherChatFn,
  updateResearchFn,
  updateResearchSourceFn,
} from './server'

const TYPE_TONE: Record<ResearchType, 'success' | 'warning' | 'neutral' | 'muted'> = {
  market: 'warning',
  audience: 'success',
  competitor: 'muted',
  product: 'neutral',
  platform: 'neutral',
  content: 'success',
  general: 'neutral',
}

const FRESHNESS_TONE: Record<Freshness, 'success' | 'warning' | 'neutral' | 'muted'> = {
  current: 'success',
  aging: 'warning',
  stale: 'muted',
  expired: 'muted',
}

const STATUS_TONE: Record<ResearchStatus, 'success' | 'warning' | 'neutral' | 'muted'> = {
  draft: 'muted',
  in_progress: 'warning',
  completed: 'success',
  stale: 'muted',
  archived: 'neutral',
}

const PROVENANCE_TONE: Record<ProvenanceStatus, 'success' | 'warning' | 'neutral' | 'muted'> = {
  sourced: 'success',
  partially_sourced: 'warning',
  user_entered: 'neutral',
}

const SOURCE_TYPE_TONE: Record<ResearchSourceType, 'success' | 'warning' | 'neutral' | 'muted'> = {
  website: 'neutral',
  report: 'warning',
  marketplace: 'neutral',
  social: 'neutral',
  internal_data: 'success',
  user_provided: 'muted',
  other: 'muted',
}

function getTypeIcon(type: ResearchType) {
  switch (type) {
    case 'market':
      return TrendingUp
    case 'audience':
      return Users
    case 'competitor':
      return Target
    case 'product':
      return Package
    case 'platform':
      return Globe
    case 'content':
      return FileText
    default:
      return FlaskConical
  }
}

function formatDisplayDate(isoString: string | null): string {
  if (!isoString) return '—'
  try {
    const d = new Date(isoString)
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return isoString
  }
}

interface ResearchCardProps {
  item: ResearchListItem
  isSelected: boolean
  isSelectable: boolean
  onToggleSelect: (id: string) => void
  onOpenDetail: (item: ResearchListItem) => void
  onEdit: (item: ResearchListItem) => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  isProcessing: boolean
}

function ResearchCard({
  item,
  isSelected,
  isSelectable,
  onToggleSelect,
  onOpenDetail,
  onEdit,
  onArchive,
  onRestore,
  isProcessing,
}: ResearchCardProps) {
  const Icon = getTypeIcon(item.researchType)
  const isArchived = item.status === 'archived' || item.deletedAt !== null

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border bg-white p-4 transition-all hover:border-zinc-300 hover:shadow-xs ${
        isSelected
          ? 'border-blue-400 bg-blue-50/20 shadow-xs ring-1 ring-blue-400'
          : isArchived
            ? 'border-zinc-200 opacity-75'
            : 'border-zinc-200'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          {/* Multi-select Checkbox */}
          <div className="pt-1">
            <input
              type="checkbox"
              checked={isSelected}
              disabled={!isSelectable || isProcessing}
              onChange={() => onToggleSelect(item.id)}
              aria-label={`Select ${item.subject} for multi-research analysis`}
              title={
                !isSelectable
                  ? 'Archived or expired research cannot be selected for analysis.'
                  : 'Select for multi-research analysis (2-10 items)'
              }
              className="size-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
            />
          </div>

          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700">
            <Icon className="size-4" strokeWidth={1.75} />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-900">{item.subject}</h3>
              <Badge tone={TYPE_TONE[item.researchType] ?? 'neutral'}>
                {item.researchTypeLabel}
              </Badge>
              <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>{item.statusLabel}</Badge>
              <Badge tone={FRESHNESS_TONE[item.freshness] ?? 'neutral'}>
                {item.freshnessLabel}
              </Badge>
              <Badge tone={PROVENANCE_TONE[item.provenance.status] ?? 'neutral'}>
                {item.provenance.label}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700">
                {item.scopeLabel}
              </span>
              <span>•</span>
              <span>Updated {formatDisplayDate(item.updatedAt)}</span>
              {item.lastVerifiedAt && (
                <>
                  <span>•</span>
                  <span>Checked {formatDisplayDate(item.lastVerifiedAt)}</span>
                </>
              )}
              {item.sources.length > 0 && (
                <>
                  <span>•</span>
                  <span>
                    {item.sources.length} source{item.sources.length > 1 ? 's' : ''}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {item.findings && (
        <p className="line-clamp-2 text-xs text-zinc-600 leading-relaxed">{item.findings}</p>
      )}

      {/* Card Actions Footer */}
      <div className="flex items-center justify-between border-t border-zinc-100 pt-3">
        <Button
          variant="ghost"
          className="h-8 px-2.5 text-xs text-zinc-600 hover:text-zinc-900"
          onClick={() => onOpenDetail(item)}
        >
          View details
          <ArrowRight className="size-3.5 ml-1" />
        </Button>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            className="h-8 px-2 text-xs text-zinc-600 hover:text-zinc-900"
            onClick={() => onEdit(item)}
            disabled={isProcessing}
          >
            <Edit3 className="size-3.5 mr-1" />
            Edit
          </Button>

          {isArchived ? (
            <Button
              variant="ghost"
              className="h-8 px-2 text-xs text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50"
              onClick={() => onRestore(item.id)}
              disabled={isProcessing}
            >
              <RotateCcw className="size-3.5 mr-1" />
              Restore
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="h-8 px-2 text-xs text-zinc-400 hover:text-red-700 hover:bg-red-50"
              onClick={() => onArchive(item.id)}
              disabled={isProcessing}
            >
              <Archive className="size-3.5 mr-1" />
              Archive
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

interface DetailModalProps {
  item: ResearchListItem
  onClose: () => void
  onEdit: (item: ResearchListItem) => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onAddSource: (researchId: string) => void
  onEditSource: (researchId: string, source: ResearchSourceRecord) => void
  onRemoveSource: (researchId: string, sourceId: string) => void
  isProcessing: boolean
}

function ResearchDetailModal({
  item,
  onClose,
  onEdit,
  onArchive,
  onRestore,
  onAddSource,
  onEditSource,
  onRemoveSource,
  isProcessing,
}: DetailModalProps) {
  const Icon = getTypeIcon(item.researchType)
  const isArchived = item.status === 'archived' || item.deletedAt !== null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={item.subject}
        className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white shadow-xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700">
              <Icon className="size-5" strokeWidth={1.75} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-zinc-900">{item.subject}</h2>
                <Badge tone={TYPE_TONE[item.researchType] ?? 'neutral'}>
                  {item.researchTypeLabel}
                </Badge>
                <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>{item.statusLabel}</Badge>
                <Badge tone={FRESHNESS_TONE[item.freshness] ?? 'neutral'}>
                  {item.freshnessLabel}
                </Badge>
                <Badge tone={PROVENANCE_TONE[item.provenance.status] ?? 'neutral'}>
                  {item.provenance.label}
                </Badge>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">Scope: {item.scopeLabel}</p>
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

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 text-xs">
            <div>
              <span className="text-zinc-400 block">Created</span>
              <strong className="text-zinc-800 font-medium">
                {formatDisplayDate(item.createdAt)}
              </strong>
            </div>
            <div>
              <span className="text-zinc-400 block">Updated</span>
              <strong className="text-zinc-800 font-medium">
                {formatDisplayDate(item.updatedAt)}
              </strong>
            </div>
            <div>
              <span className="text-zinc-400 block">Last Checked</span>
              <strong className="text-zinc-800 font-medium">
                {formatDisplayDate(item.lastVerifiedAt)}
              </strong>
            </div>
            <div>
              <span className="text-zinc-400 block">Confidence</span>
              <strong className="text-zinc-800 font-medium">
                {item.confidence !== null ? `${Math.round(item.confidence * 100)}%` : '—'}
              </strong>
            </div>
          </div>

          {/* Provenance Summary Banner */}
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3.5 text-xs text-zinc-700 flex items-start gap-2.5">
            <ShieldCheck className="size-4 text-zinc-500 mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              <div className="font-semibold text-zinc-900 flex items-center gap-2">
                <span>Provenance: {item.provenance.label}</span>
                <Badge tone={PROVENANCE_TONE[item.provenance.status] ?? 'neutral'}>
                  {item.sources.length} {item.sources.length === 1 ? 'Source' : 'Sources'}
                </Badge>
              </div>
              <p className="text-zinc-600 leading-relaxed">{item.provenance.description}</p>
            </div>
          </div>

          {/* Sources & Provenance Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
                <BookOpen className="size-3.5" />
                Sources & Citations ({item.sources.length})
              </h4>
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200"
                onClick={() => onAddSource(item.id)}
                disabled={isProcessing}
              >
                <Plus className="size-3.5 mr-1" />
                Add source
              </Button>
            </div>

            {item.sources.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/50 p-4 text-center">
                <p className="text-xs text-zinc-500">
                  No sources attached yet. This research is user-entered and has no external
                  provenance recorded.
                </p>
                <Button
                  variant="secondary"
                  onClick={() => onAddSource(item.id)}
                  className="mt-2.5 text-xs inline-flex items-center gap-1"
                >
                  <Plus className="size-3.5" />
                  Add first source
                </Button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {item.sources.map((source) => (
                  <div
                    key={source.id}
                    className="rounded-lg border border-zinc-200 bg-white p-3 text-xs space-y-2 transition-colors hover:border-zinc-300"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5">
                        <div className="flex size-7 shrink-0 items-center justify-center rounded bg-zinc-100 text-zinc-700 mt-0.5">
                          <Link2 className="size-3.5" />
                        </div>
                        <div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <h5 className="font-semibold text-zinc-900">{source.title}</h5>
                            <Badge tone={SOURCE_TYPE_TONE[source.sourceType] ?? 'neutral'}>
                              {RESEARCH_SOURCE_TYPE_LABELS[source.sourceType] ?? source.sourceType}
                            </Badge>
                            {source.confidence !== null && (
                              <span className="text-[11px] text-zinc-500 font-medium">
                                Credibility: {Math.round(source.confidence * 100)}%
                              </span>
                            )}
                          </div>
                          {source.publisher && (
                            <p className="text-[11px] text-zinc-600 mt-0.5">
                              Publisher / Author:{' '}
                              <span className="font-medium text-zinc-800">{source.publisher}</span>
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Source Action Buttons */}
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          className="h-7 px-2 text-xs text-zinc-600 hover:text-zinc-900"
                          onClick={() => onEditSource(item.id, source)}
                          disabled={isProcessing}
                        >
                          <Edit3 className="size-3 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-7 px-2 text-xs text-zinc-400 hover:text-red-700 hover:bg-red-50"
                          onClick={() => onRemoveSource(item.id, source.id)}
                          disabled={isProcessing}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </div>

                    {/* Dates & URL */}
                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500 pt-0.5">
                      {source.publishedAt && (
                        <span>Published: {formatDisplayDate(source.publishedAt)}</span>
                      )}
                      {source.retrievedAt && (
                        <span>Accessed: {formatDisplayDate(source.retrievedAt)}</span>
                      )}
                      {source.url && (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline max-w-sm truncate"
                        >
                          <ExternalLink className="size-3 shrink-0" />
                          <span className="truncate">{source.url}</span>
                        </a>
                      )}
                    </div>

                    {source.note && (
                      <p className="text-[11px] text-zinc-700 bg-zinc-50 rounded p-2 border border-zinc-100 leading-relaxed">
                        {source.note}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Findings & Content */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
              <FileText className="size-3.5" />
              Research Findings & Notes
            </h4>
            <div className="rounded-lg border border-zinc-200 bg-white p-4 text-xs sm:text-sm text-zinc-800 whitespace-pre-wrap leading-relaxed">
              {item.findings || <span className="italic text-zinc-400">No findings recorded.</span>}
            </div>
          </div>

          {/* Freshness description notice */}
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
            <div className="font-semibold text-zinc-800 mb-0.5">
              Freshness: {item.freshnessLabel}
            </div>
            {item.freshness === 'current' && (
              <p>
                This research was recently checked or updated and is actively used by AI reasoning.
              </p>
            )}
            {item.freshness === 'aging' && (
              <p>
                This completed research has not been verified within 90 days. It remains accessible
                but may benefit from a check.
              </p>
            )}
            {item.freshness === 'stale' && (
              <p>
                This research has been marked stale and will be labeled as outdated when referenced.
              </p>
            )}
            {item.freshness === 'expired' && (
              <p>
                This research has passed its expiration date or is archived and is excluded from
                active AI context.
              </p>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-zinc-100 px-6 py-4 bg-zinc-50 rounded-b-xl">
          <Button variant="ghost" onClick={onClose} className="text-xs">
            Close
          </Button>

          <div className="flex items-center gap-2">
            {isArchived ? (
              <Button
                variant="secondary"
                className="text-xs text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                onClick={() => {
                  onRestore(item.id)
                  onClose()
                }}
                disabled={isProcessing}
              >
                <RotateCcw className="size-3.5 mr-1" />
                Restore research
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="text-xs text-zinc-500 hover:text-red-700 hover:bg-red-50"
                onClick={() => {
                  onArchive(item.id)
                  onClose()
                }}
                disabled={isProcessing}
              >
                <Archive className="size-3.5 mr-1" />
                Archive
              </Button>
            )}

            <Button
              variant="primary"
              className="text-xs"
              onClick={() => {
                onClose()
                onEdit(item)
              }}
              disabled={isProcessing}
            >
              <Edit3 className="size-3.5 mr-1" />
              Edit research
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface FormModalProps {
  initialItem?: ResearchListItem | null
  brands: Array<{ id: string; name: string }>
  niches: Array<{ id: string; name: string; brandId: string }>
  products: Array<{ id: string; name: string; brandId: string }>
  accounts: Array<{ id: string; name: string }>
  onClose: () => void
  onSubmit: (formData: {
    id?: string
    subject: string
    findings?: string | null
    researchType: ResearchType
    status: ResearchStatus
    confidence?: number | null
    scopeType?: ResearchScopeType | null
    scopeId?: string | null
    lastVerifiedAt?: string | null
    expiresAt?: string | null
  }) => void
  isSubmitting: boolean
}

function ResearchFormModal({
  initialItem,
  brands,
  niches,
  products,
  accounts,
  onClose,
  onSubmit,
  isSubmitting,
}: FormModalProps) {
  const isEditing = Boolean(initialItem)

  const [subject, setSubject] = useState(initialItem?.subject ?? '')
  const [findings, setFindings] = useState(initialItem?.findings ?? '')
  const [researchType, setResearchType] = useState<ResearchType>(
    initialItem?.researchType ?? 'general',
  )
  const [status, setStatus] = useState<ResearchStatus>(initialItem?.status ?? 'completed')
  const [scopeType, setScopeType] = useState<ResearchScopeType | 'workspace'>(
    initialItem?.scopeType ?? 'workspace',
  )
  const [scopeId, setScopeId] = useState<string>(initialItem?.scopeId ?? '')
  const [confidence, setConfidence] = useState<number | ''>(
    initialItem?.confidence !== null && initialItem?.confidence !== undefined
      ? Math.round(initialItem.confidence * 100)
      : '',
  )
  const [lastVerifiedAt, setLastVerifiedAt] = useState(
    initialItem?.lastVerifiedAt ? initialItem.lastVerifiedAt.slice(0, 10) : '',
  )
  const [expiresAt, setExpiresAt] = useState(
    initialItem?.expiresAt ? initialItem.expiresAt.slice(0, 10) : '',
  )
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!subject.trim()) {
      setError('Title is required')
      return
    }

    if (scopeType !== 'workspace' && !scopeId) {
      setError(`Please select an entity for scope '${scopeType}'`)
      return
    }

    const confVal = confidence !== '' ? Number(confidence) / 100 : null

    onSubmit({
      ...(isEditing && initialItem ? { id: initialItem.id } : {}),
      subject: subject.trim(),
      findings: findings.trim() || null,
      researchType,
      status,
      confidence: confVal,
      scopeType: scopeType === 'workspace' ? null : scopeType,
      scopeId: scopeType === 'workspace' ? null : scopeId,
      lastVerifiedAt: lastVerifiedAt ? new Date(lastVerifiedAt).toISOString() : null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? 'Edit Research' : 'Create Research'}
        className="w-full max-w-xl rounded-xl border border-zinc-200 bg-white shadow-xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {isEditing ? 'Edit Research Finding' : 'Add Research Finding'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-4 text-xs"
        >
          {error && (
            <div className="rounded bg-red-50 p-2.5 text-red-800 border border-red-200">
              {error}
            </div>
          )}

          {/* Title */}
          <div className="space-y-1">
            <label htmlFor="res-title" className="font-medium text-zinc-700">
              Title / Subject <span className="text-red-500">*</span>
            </label>
            <input
              id="res-title"
              type="text"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Minimalist Tech Audience Demographics"
              className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
            />
          </div>

          {/* Type & Status */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="res-type" className="font-medium text-zinc-700">
                Research Type
              </label>
              <select
                id="res-type"
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
              <label htmlFor="res-status" className="font-medium text-zinc-700">
                Status
              </label>
              <select
                id="res-status"
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
              <label htmlFor="res-scope-type" className="font-medium text-zinc-700">
                Scope
              </label>
              <select
                id="res-scope-type"
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
                <option value="platform">Platform</option>
              </select>
            </div>

            {scopeType !== 'workspace' && (
              <div className="space-y-1">
                <label htmlFor="res-scope-id" className="font-medium text-zinc-700">
                  Target {scopeType.charAt(0).toUpperCase() + scopeType.slice(1)}
                </label>
                <select
                  id="res-scope-id"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
                >
                  <option value="">Select {scopeType}…</option>
                  {scopeType === 'brand' &&
                    brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  {scopeType === 'niche' &&
                    niches.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  {scopeType === 'product' &&
                    products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  {scopeType === 'account' &&
                    accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  {scopeType === 'platform' && (
                    <>
                      <option value="pinterest">Pinterest</option>
                      <option value="instagram">Instagram</option>
                      <option value="tiktok">TikTok</option>
                    </>
                  )}
                </select>
              </div>
            )}
          </div>

          {/* Findings Content */}
          <div className="space-y-1">
            <label htmlFor="res-findings" className="font-medium text-zinc-700">
              Findings / Content (Markdown supported)
            </label>
            <textarea
              id="res-findings"
              rows={6}
              value={findings}
              onChange={(e) => setFindings(e.target.value)}
              placeholder="Document the facts, insights, competitor analysis, or market research findings…"
              className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden font-mono"
            />
          </div>

          {/* Confidence and Verification date */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label htmlFor="res-confidence" className="font-medium text-zinc-700">
                Confidence (0–100%)
              </label>
              <input
                id="res-confidence"
                type="number"
                min="0"
                max="100"
                value={confidence}
                onChange={(e) => setConfidence(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="e.g. 85"
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="res-verified" className="font-medium text-zinc-700">
                Last Checked Date
              </label>
              <input
                id="res-verified"
                type="date"
                value={lastVerifiedAt}
                onChange={(e) => setLastVerifiedAt(e.target.value)}
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="res-expires" className="font-medium text-zinc-700">
                Expires Date (optional)
              </label>
              <input
                id="res-expires"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-end gap-2 border-t border-zinc-100 pt-4">
            <Button variant="ghost" type="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? isEditing
                  ? 'Saving…'
                  : 'Creating…'
                : isEditing
                  ? 'Save Changes'
                  : 'Create Research'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface SourceFormModalProps {
  researchId: string
  initialSource?: ResearchSourceRecord | null
  onClose: () => void
  onSubmit: (formData: {
    researchId: string
    id?: string
    sourceType: ResearchSourceType
    title: string
    url?: string | null
    publisher?: string | null
    publishedAt?: string | null
    retrievedAt?: string | null
    note?: string | null
    confidence?: number | null
  }) => void
  isSubmitting: boolean
}

function SourceFormModal({
  researchId,
  initialSource,
  onClose,
  onSubmit,
  isSubmitting,
}: SourceFormModalProps) {
  const isEditing = Boolean(initialSource)

  const [sourceType, setSourceType] = useState<ResearchSourceType>(
    initialSource?.sourceType ?? 'website',
  )
  const [title, setTitle] = useState(initialSource?.title ?? '')
  const [url, setUrl] = useState(initialSource?.url ?? '')
  const [publisher, setPublisher] = useState(initialSource?.publisher ?? '')
  const [publishedAt, setPublishedAt] = useState(
    initialSource?.publishedAt ? initialSource.publishedAt.slice(0, 10) : '',
  )
  const [retrievedAt, setRetrievedAt] = useState(
    initialSource?.retrievedAt
      ? initialSource.retrievedAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10),
  )
  const [confidence, setConfidence] = useState<number | ''>(
    initialSource?.confidence !== null && initialSource?.confidence !== undefined
      ? Math.round(initialSource.confidence * 100)
      : '',
  )
  const [note, setNote] = useState(initialSource?.note ?? '')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) {
      setError('Source title is required')
      return
    }

    if (url.trim()) {
      try {
        const parsed = new URL(url.trim())
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setError('URL must start with http:// or https://')
          return
        }
      } catch {
        setError('Please enter a valid URL (e.g. https://example.com/report)')
        return
      }
    }

    const confVal = confidence !== '' ? Number(confidence) / 100 : null

    onSubmit({
      researchId,
      ...(isEditing && initialSource ? { id: initialSource.id } : {}),
      sourceType,
      title: title.trim(),
      url: url.trim() || null,
      publisher: publisher.trim() || null,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      retrievedAt: retrievedAt ? new Date(retrievedAt).toISOString() : null,
      note: note.trim() || null,
      confidence: confVal,
    })
  }

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-zinc-950/40 p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? 'Edit Source' : 'Add Source'}
        className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white shadow-xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
          <h3 className="text-sm font-semibold text-zinc-900">
            {isEditing ? 'Edit Source / Citation' : 'Add Source / Citation'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-4 text-xs"
        >
          {error && (
            <div className="rounded bg-red-50 p-2.5 text-red-800 border border-red-200">
              {error}
            </div>
          )}

          {/* Type & Title */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label htmlFor="src-type" className="font-medium text-zinc-700">
                Source Type
              </label>
              <select
                id="src-type"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as ResearchSourceType)}
                className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              >
                {RESEARCH_SOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {RESEARCH_SOURCE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="src-title" className="font-medium text-zinc-700">
                Title / Name <span className="text-red-500">*</span>
              </label>
              <input
                id="src-title"
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. 2026 Spreadsheet Market Growth Report"
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>
          </div>

          {/* URL & Publisher */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="src-url" className="font-medium text-zinc-700">
                Source URL (optional)
              </label>
              <input
                id="src-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/source"
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="src-publisher" className="font-medium text-zinc-700">
                Publisher / Author (optional)
              </label>
              <input
                id="src-publisher"
                type="text"
                value={publisher}
                onChange={(e) => setPublisher(e.target.value)}
                placeholder="e.g. Statista / Gartner"
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>
          </div>

          {/* Dates & Confidence */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label htmlFor="src-published" className="font-medium text-zinc-700">
                Published Date
              </label>
              <input
                id="src-published"
                type="date"
                value={publishedAt}
                onChange={(e) => setPublishedAt(e.target.value)}
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="src-retrieved" className="font-medium text-zinc-700">
                Accessed / Checked Date
              </label>
              <input
                id="src-retrieved"
                type="date"
                value={retrievedAt}
                onChange={(e) => setRetrievedAt(e.target.value)}
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="src-confidence" className="font-medium text-zinc-700">
                Credibility (0–100%)
              </label>
              <input
                id="src-confidence"
                type="number"
                min="0"
                max="100"
                value={confidence}
                onChange={(e) => setConfidence(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="e.g. 90"
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>
          </div>

          {/* Note */}
          <div className="space-y-1">
            <label htmlFor="src-note" className="font-medium text-zinc-700">
              Short Note / Context (optional)
            </label>
            <textarea
              id="src-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Key quote, methodology summary, or context about why this source is cited…"
              className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
            />
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-end gap-2 border-t border-zinc-100 pt-4">
            <Button variant="ghost" type="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? isEditing
                  ? 'Saving…'
                  : 'Adding…'
                : isEditing
                  ? 'Save Source'
                  : 'Add Source'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function ResearchPage() {
  const queryClient = useQueryClient()

  const [searchTerm, setSearchTerm] = useState('')
  const [selectedType, setSelectedType] = useState<string>('all')
  const [selectedScope, setSelectedScope] = useState<string>('all')
  const [selectedFreshness, setSelectedFreshness] = useState<string>('all')
  const [selectedStatus, setSelectedStatus] = useState<string>('all')

  const [detailItem, setDetailItem] = useState<ResearchListItem | null>(null)
  const [editingItem, setEditingItem] = useState<ResearchListItem | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [addingSourceResearchId, setAddingSourceResearchId] = useState<string | null>(null)
  const [editingSource, setEditingSource] = useState<{
    researchId: string
    source: ResearchSourceRecord
  } | null>(null)

  const overview = useQuery({
    queryKey: ['research-overview'],
    queryFn: () => listResearchOverview({ data: {} }),
  })

  const createMutation = useMutation({
    mutationFn: (vars: Parameters<typeof createResearchFn>[0]['data']) =>
      createResearchFn({ data: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research-overview'] })
      setIsCreating(false)
    },
  })

  const updateMutation = useMutation({
    mutationFn: (vars: Parameters<typeof updateResearchFn>[0]['data']) =>
      updateResearchFn({ data: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research-overview'] })
      setEditingItem(null)
      setDetailItem(null)
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveResearchFn({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research-overview'] })
      setDetailItem(null)
    },
  })

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restoreResearchFn({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research-overview'] })
      setDetailItem(null)
    },
  })

  const addSourceMutation = useMutation({
    mutationFn: (vars: Parameters<typeof addResearchSourceFn>[0]['data']) =>
      addResearchSourceFn({ data: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research-overview'] })
      setAddingSourceResearchId(null)
    },
  })

  const updateSourceMutation = useMutation({
    mutationFn: (vars: Parameters<typeof updateResearchSourceFn>[0]['data']) =>
      updateResearchSourceFn({ data: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research-overview'] })
      setEditingSource(null)
    },
  })

  const removeSourceMutation = useMutation({
    mutationFn: (vars: Parameters<typeof removeResearchSourceFn>[0]['data']) =>
      removeResearchSourceFn({ data: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research-overview'] })
    },
  })

  const allItems: ResearchListItem[] = overview.data?.items ?? []
  const brands = overview.data?.brands ?? []
  const niches = overview.data?.niches ?? []
  const products = overview.data?.products ?? []
  const accounts = overview.data?.accounts ?? []

  // Keep detail item in sync with updated overview cache
  const activeDetailItem = detailItem
    ? (allItems.find((i) => i.id === detailItem.id) ?? detailItem)
    : null

  // Filter items
  const filteredItems = allItems.filter((item: ResearchListItem) => {
    if (selectedType !== 'all' && item.researchType !== selectedType) return false
    if (selectedFreshness !== 'all' && item.freshness !== selectedFreshness) return false
    if (selectedStatus !== 'all' && item.status !== selectedStatus) return false
    if (selectedScope !== 'all') {
      if (selectedScope === 'workspace' && item.scopeType && item.scopeType !== 'workspace') {
        return false
      }
      if (selectedScope.startsWith('brand:') && item.scopeId !== selectedScope.slice(6)) {
        return false
      }
    }
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase()
      const inSubject = item.subject.toLowerCase().includes(term)
      const inFindings = item.findings ? item.findings.toLowerCase().includes(term) : false
      if (!inSubject && !inFindings) return false
    }
    return true
  })

  const isProcessing =
    createMutation.isPending ||
    updateMutation.isPending ||
    archiveMutation.isPending ||
    restoreMutation.isPending ||
    addSourceMutation.isPending ||
    updateSourceMutation.isPending ||
    removeSourceMutation.isPending

  const navigate = useNavigate()
  const [isAskingResearcher, setIsAskingResearcher] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)

  const isItemSelectable = (item: ResearchListItem) =>
    item.status !== 'archived' && item.freshness !== 'expired' && item.deletedAt === null

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      if (next.size >= MAX_RESEARCH_ANALYSIS_SELECTION) {
        setAnalysisError(
          `You can select at most ${MAX_RESEARCH_ANALYSIS_SELECTION} research records.`,
        )
        return
      }
      next.add(id)
      setAnalysisError(null)
    }
    setSelectedIds(next)
  }

  const handleAnalyzeTogether = async (mode: ResearchAnalysisMode) => {
    if (selectedIds.size < MIN_RESEARCH_ANALYSIS_SELECTION) {
      setAnalysisError(
        `Please select at least ${MIN_RESEARCH_ANALYSIS_SELECTION} records to analyze together.`,
      )
      return
    }
    if (selectedIds.size > MAX_RESEARCH_ANALYSIS_SELECTION) {
      setAnalysisError(`Please select at most ${MAX_RESEARCH_ANALYSIS_SELECTION} research records.`)
      return
    }
    setIsAnalyzing(true)
    setAnalysisError(null)
    try {
      const res = await startResearchAnalysisChatFn({
        data: {
          researchIds: Array.from(selectedIds),
          mode,
        },
      })
      if (res.agentId) {
        navigate({
          to: '/chat/$conversationId',
          params: { conversationId: res.conversationId },
          search: { agent: res.agentId },
        })
      } else {
        navigate({
          to: '/chat/$conversationId',
          params: { conversationId: res.conversationId },
        })
      }
    } catch (err: unknown) {
      setAnalysisError(err instanceof Error ? err.message : 'Failed to launch research analysis.')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const handleAskResearcher = async () => {
    setIsAskingResearcher(true)
    try {
      let targetScopeType: 'brand' | 'product' | 'account' | 'campaign' | 'niche' | null = null
      let targetScopeId: string | null = null

      if (selectedScope.startsWith('brand:')) {
        targetScopeType = 'brand'
        targetScopeId = selectedScope.slice(6)
      } else if (selectedScope.startsWith('product:')) {
        targetScopeType = 'product'
        targetScopeId = selectedScope.slice(8)
      } else if (selectedScope.startsWith('niche:')) {
        targetScopeType = 'niche'
        targetScopeId = selectedScope.slice(6)
      } else if (selectedScope.startsWith('account:')) {
        targetScopeType = 'account'
        targetScopeId = selectedScope.slice(8)
      }

      const res = await startResearcherChatFn({
        data: {
          scopeType: targetScopeType,
          scopeId: targetScopeId,
        },
      })

      if (res.agentId) {
        navigate({
          to: '/chat/$conversationId',
          params: { conversationId: res.conversationId },
          search: { agent: res.agentId },
        })
      } else {
        navigate({
          to: '/chat/$conversationId',
          params: { conversationId: res.conversationId },
        })
      }
    } finally {
      setIsAskingResearcher(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6 pb-24">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title="Research"
          description="Store and manage workspace intelligence, market findings, and strategic knowledge."
        />
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={handleAskResearcher}
            disabled={isAskingResearcher}
            className="shrink-0 flex items-center gap-1.5 text-blue-600 hover:text-blue-700"
          >
            <Bot className="size-4" />
            {isAskingResearcher ? 'Opening Chat…' : 'Ask Researcher'}
          </Button>
          <Button
            variant="primary"
            onClick={() => setIsCreating(true)}
            className="shrink-0 flex items-center gap-1.5"
          >
            <Plus className="size-4" />
            Add Research
          </Button>
        </div>
      </div>

      {/* Analysis Error Alert if any */}
      {analysisError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 flex items-center justify-between">
          <span>{analysisError}</span>
          <Button
            variant="ghost"
            onClick={() => setAnalysisError(null)}
            className="h-6 px-1.5 text-red-600 hover:bg-red-100"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {/* Filters Bar */}
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-3.5">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-zinc-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search findings and topics…"
              className="w-full rounded-md border border-zinc-200 pl-8 pr-3 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:outline-hidden"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Type filter */}
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-700 focus:border-zinc-400 focus:outline-hidden"
            >
              <option value="all">All Types</option>
              {RESEARCH_TYPES.map((t) => (
                <option key={t} value={t}>
                  {RESEARCH_TYPE_LABELS[t]}
                </option>
              ))}
            </select>

            {/* Scope filter */}
            <select
              value={selectedScope}
              onChange={(e) => setSelectedScope(e.target.value)}
              className="rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-700 focus:border-zinc-400 focus:outline-hidden"
            >
              <option value="all">All Scopes</option>
              <option value="workspace">Workspace-wide</option>
              {brands.map((b) => (
                <option key={b.id} value={`brand:${b.id}`}>
                  Brand: {b.name}
                </option>
              ))}
            </select>

            {/* Freshness filter */}
            <select
              value={selectedFreshness}
              onChange={(e) => setSelectedFreshness(e.target.value)}
              className="rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-700 focus:border-zinc-400 focus:outline-hidden"
            >
              <option value="all">All Freshness</option>
              <option value="current">Current</option>
              <option value="aging">Aging</option>
              <option value="stale">Stale</option>
              <option value="expired">Expired</option>
            </select>

            {/* Status filter */}
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-700 focus:border-zinc-400 focus:outline-hidden"
            >
              <option value="all">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="draft">Draft</option>
              <option value="in_progress">In Progress</option>
              <option value="stale">Stale</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Research List */}
      {filteredItems.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No research found"
          description={
            allItems.length === 0
              ? 'Add your first research finding to provide strategic intelligence for your workspace.'
              : 'No research findings matched your search and filter criteria.'
          }
          action={
            allItems.length === 0 ? (
              <Button variant="primary" onClick={() => setIsCreating(true)} className="text-xs">
                <Plus className="size-3.5 mr-1" />
                Add first research
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {filteredItems.map((item) => (
            <ResearchCard
              key={item.id}
              item={item}
              isSelected={selectedIds.has(item.id)}
              isSelectable={isItemSelectable(item)}
              onToggleSelect={toggleSelect}
              onOpenDetail={(i) => setDetailItem(i)}
              onEdit={(i) => setEditingItem(i)}
              onArchive={(id) => archiveMutation.mutate(id)}
              onRestore={(id) => restoreMutation.mutate(id)}
              isProcessing={isProcessing}
            />
          ))}
        </div>
      )}

      {/* Multi-Select Floating / Sticky Action Bar */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-4 z-30 flex flex-col sm:flex-row items-center justify-between gap-3 rounded-xl border border-blue-200 bg-white/95 p-3.5 shadow-lg backdrop-blur-md">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <div className="flex items-center gap-2">
              <Badge tone="neutral">{selectedIds.size} selected</Badge>
              <span className="text-xs text-zinc-700 font-medium">
                Analyze together with Researcher:
              </span>
            </div>
            <span className="text-xs text-zinc-500">
              (Min {MIN_RESEARCH_ANALYSIS_SELECTION}, Max {MAX_RESEARCH_ANALYSIS_SELECTION})
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {RESEARCH_ANALYSIS_MODES.map((mode) => (
              <Button
                key={mode}
                variant="secondary"
                className="text-xs h-8 px-3 font-medium bg-white hover:bg-blue-50 hover:text-blue-700 border-zinc-200"
                onClick={() => handleAnalyzeTogether(mode)}
                disabled={
                  isAnalyzing ||
                  selectedIds.size < MIN_RESEARCH_ANALYSIS_SELECTION ||
                  selectedIds.size > MAX_RESEARCH_ANALYSIS_SELECTION
                }
              >
                {mode === 'compare' && <GitCompare className="size-3.5 mr-1 text-blue-600" />}
                {mode === 'synthesize' && <Layers className="size-3.5 mr-1 text-indigo-600" />}
                {mode === 'patterns' && <Sparkles className="size-3.5 mr-1 text-amber-600" />}
                {mode === 'contradictions' && (
                  <AlertTriangle className="size-3.5 mr-1 text-rose-600" />
                )}
                {isAnalyzing ? 'Analyzing…' : RESEARCH_ANALYSIS_MODE_LABELS[mode]}
              </Button>
            ))}

            <Button
              variant="ghost"
              className="text-xs h-8 px-2 text-zinc-500 hover:text-zinc-800"
              onClick={() => setSelectedIds(new Set())}
              disabled={isAnalyzing}
            >
              <X className="size-3.5 mr-1" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Detail Dialog */}
      {activeDetailItem && (
        <ResearchDetailModal
          item={activeDetailItem}
          onClose={() => setDetailItem(null)}
          onEdit={(i) => setEditingItem(i)}
          onArchive={(id) => archiveMutation.mutate(id)}
          onRestore={(id) => restoreMutation.mutate(id)}
          onAddSource={(researchId) => setAddingSourceResearchId(researchId)}
          onEditSource={(researchId, source) => setEditingSource({ researchId, source })}
          onRemoveSource={(researchId, sourceId) =>
            removeSourceMutation.mutate({ researchId, id: sourceId })
          }
          isProcessing={isProcessing}
        />
      )}

      {/* Create Research Dialog */}
      {isCreating && (
        <ResearchFormModal
          brands={brands}
          niches={niches}
          products={products}
          accounts={accounts}
          onClose={() => setIsCreating(false)}
          onSubmit={(data) => {
            createMutation.mutate({
              subject: data.subject,
              findings: data.findings,
              researchType: data.researchType,
              status: data.status,
              confidence: data.confidence,
              scopeType: data.scopeType,
              scopeId: data.scopeId,
              lastVerifiedAt: data.lastVerifiedAt,
              expiresAt: data.expiresAt,
            })
          }}
          isSubmitting={createMutation.isPending}
        />
      )}

      {/* Edit Research Dialog */}
      {editingItem && (
        <ResearchFormModal
          initialItem={editingItem}
          brands={brands}
          niches={niches}
          products={products}
          accounts={accounts}
          onClose={() => setEditingItem(null)}
          onSubmit={(data) => {
            if (data.id) {
              updateMutation.mutate({
                id: data.id,
                subject: data.subject,
                findings: data.findings,
                researchType: data.researchType,
                status: data.status,
                confidence: data.confidence,
                scopeType: data.scopeType,
                scopeId: data.scopeId,
                lastVerifiedAt: data.lastVerifiedAt,
                expiresAt: data.expiresAt,
              })
            }
          }}
          isSubmitting={updateMutation.isPending}
        />
      )}

      {/* Add Source Dialog */}
      {addingSourceResearchId && (
        <SourceFormModal
          researchId={addingSourceResearchId}
          onClose={() => setAddingSourceResearchId(null)}
          onSubmit={(data) => {
            addSourceMutation.mutate(data)
          }}
          isSubmitting={addSourceMutation.isPending}
        />
      )}

      {/* Edit Source Dialog */}
      {editingSource && (
        <SourceFormModal
          researchId={editingSource.researchId}
          initialSource={editingSource.source}
          onClose={() => setEditingSource(null)}
          onSubmit={(data) => {
            if (data.id) {
              updateSourceMutation.mutate({
                researchId: data.researchId,
                id: data.id,
                sourceType: data.sourceType,
                title: data.title,
                url: data.url,
                publisher: data.publisher,
                publishedAt: data.publishedAt,
                retrievedAt: data.retrievedAt,
                note: data.note,
                confidence: data.confidence,
              })
            }
          }}
          isSubmitting={updateSourceMutation.isPending}
        />
      )}
    </div>
  )
}
