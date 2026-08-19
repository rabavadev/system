import { useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  Brain,
  Eye,
  Pencil,
  Plus,
  Replace,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/empty-state'
import { inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'

import { MemoryEditorDialog, ScopeSelect } from './memory-editor'
import {
  filterMemories,
  formatMemoryDate,
  MEMORY_TABS,
  type MemoryTab,
  memoriesForTab,
} from './memory-view'
import type { MemoryListItem, MemoryPageData } from './server'
import { archiveMemoryFn, rejectMemoryFn, restoreMemoryFn } from './server'

interface MemoryPageProps {
  data: MemoryPageData
}

function countForTab(data: MemoryPageData, tab: MemoryTab): number {
  switch (tab) {
    case 'facts':
      return data.counts.importantFacts
    case 'verified':
      return data.counts.verifiedLearnings
    case 'review':
      return data.counts.needsReview
    case 'temporary':
      return data.counts.temporary
    case 'history':
      return data.memories.filter((memory) => memory.status !== 'active').length
    default:
      return data.memories.filter((memory) => memory.status === 'active').length
  }
}

function emptyCopy(tab: MemoryTab): { title: string; description: string } {
  switch (tab) {
    case 'facts':
      return {
        title: 'No important facts yet',
        description: 'Save important information you want Chief to remember.',
      }
    case 'verified':
      return {
        title: 'No verified learnings yet',
        description: 'Verified learnings will appear here once you confirm what works.',
      }
    case 'review':
      return {
        title: 'Nothing needs verification',
        description: 'Proposed learnings will appear here when they need your review.',
      }
    case 'temporary':
      return {
        title: 'No temporary context',
        description: 'Save short-lived context for this week, a test, or a current constraint.',
      }
    case 'history':
      return {
        title: 'No archived memory',
        description: 'Archived, rejected, and replaced memories stay here for history.',
      }
    default:
      return {
        title: 'No memories yet',
        description: 'Save facts, learnings, and temporary context you want Chief to use.',
      }
  }
}

export function MemoryPage({ data }: MemoryPageProps) {
  const router = useRouter()
  const [tab, setTab] = useState<MemoryTab>('all')
  const [query, setQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState('')
  const [freshness, setFreshness] = useState('')
  const [detail, setDetail] = useState<MemoryListItem | null>(null)
  const [editor, setEditor] = useState<
    { mode: 'create' } | { mode: 'edit' | 'verify' | 'supersede'; memory: MemoryListItem } | null
  >(null)
  const [pending, startTransition] = useTransition()

  const visible = filterMemories(memoriesForTab(data.memories, tab), {
    query,
    scopeValue: scopeFilter || undefined,
    freshness: freshness || undefined,
  })
  const empty = emptyCopy(tab)

  function run(action: () => Promise<void>) {
    startTransition(async () => {
      await action()
      await router.invalidate()
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Memory"
        description="What you want Chief to remember, review, or stop using."
        actions={
          <Button onClick={() => setEditor({ mode: 'create' })}>
            <Plus className="size-4" strokeWidth={1.75} />
            New memory
          </Button>
        }
      />

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <SummaryCard label="Important Facts" value={data.counts.importantFacts} />
        <SummaryCard label="Verified Learnings" value={data.counts.verifiedLearnings} />
        <SummaryCard label="Needs Review" value={data.counts.needsReview} />
        <SummaryCard label="Temporary" value={data.counts.temporary} />
        <SummaryCard label="Archived" value={data.counts.archived} />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          {MEMORY_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
                tab === item.id
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
              }`}
            >
              {item.label}
              <span className="ml-1.5 text-xs opacity-70">{countForTab(data, item.id)}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_220px_150px]">
          <input
            aria-label="Search memory"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memory"
            className={inputClass}
          />
          <ScopeSelect
            value={scopeFilter}
            onChange={setScopeFilter}
            options={data.scopeOptions}
            includeAll
          />
          <select
            aria-label="Filter by freshness"
            value={freshness}
            onChange={(event) => setFreshness(event.target.value)}
            className={inputClass}
          >
            <option value="">Any freshness</option>
            <option value="current">Current</option>
            <option value="expired">Expired</option>
          </select>
        </div>
      </section>

      {visible.length === 0 ? (
        <EmptyState
          icon={Brain}
          title={empty.title}
          description={empty.description}
          action={
            tab !== 'history' ? (
              <Button onClick={() => setEditor({ mode: 'create' })}>
                <Plus className="size-4" strokeWidth={1.75} />
                New memory
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              pending={pending}
              onView={() => setDetail(memory)}
              onEdit={() => setEditor({ mode: 'edit', memory })}
              onVerify={() => setEditor({ mode: 'verify', memory })}
              onSupersede={() => setEditor({ mode: 'supersede', memory })}
              onArchive={() => run(() => archiveMemoryFn({ data: { id: memory.id } }))}
              onRestore={() => run(() => restoreMemoryFn({ data: { id: memory.id } }))}
              onReject={() => run(() => rejectMemoryFn({ data: { id: memory.id } }))}
            />
          ))}
        </ul>
      )}

      {editor ? (
        <MemoryEditorDialog
          mode={editor.mode}
          memory={'memory' in editor ? editor.memory : undefined}
          scopeOptions={data.scopeOptions}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {detail ? <MemoryDetailDialog memory={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-900">{value}</p>
    </div>
  )
}

interface MemoryRowProps {
  memory: MemoryListItem
  pending: boolean
  onView: () => void
  onEdit: () => void
  onVerify: () => void
  onSupersede: () => void
  onArchive: () => Promise<void> | void
  onRestore: () => Promise<void> | void
  onReject: () => Promise<void> | void
}

function MemoryRow({
  memory,
  pending,
  onView,
  onEdit,
  onVerify,
  onSupersede,
  onArchive,
  onRestore,
  onReject,
}: MemoryRowProps) {
  const active = memory.status === 'active'
  return (
    <li className="rounded-md border border-zinc-200 bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={onView} className="min-w-0 flex-1 text-left">
          <p className="line-clamp-2 text-sm font-medium text-zinc-900">{memory.content}</p>
          <p className="mt-1 truncate text-xs text-zinc-400">
            Applies to {memory.scopePath}
            {memory.scopeArchived ? ' (archived item)' : ''}
          </p>
        </button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <Badge tone={memory.memoryClass === 'proposed_learning' ? 'warning' : 'neutral'}>
            {memory.typeLabel}
          </Badge>
          {memory.confidenceLabel ? <Badge tone="neutral">{memory.confidenceLabel}</Badge> : null}
          <Badge tone={memory.freshness === 'expired' ? 'warning' : active ? 'success' : 'muted'}>
            {memory.status !== 'active'
              ? memory.statusLabel
              : memory.freshness === 'expired'
                ? 'Expired'
                : 'Current'}
          </Badge>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <span>Source: {memory.sourceLabel}</span>
        {memory.lastVerifiedAt ? (
          <span>Verified {formatMemoryDate(memory.lastVerifiedAt)}</span>
        ) : null}
        {memory.expiresAt ? <span>Expires {formatMemoryDate(memory.expiresAt)}</span> : null}
        {memory.evidenceText ? (
          <span className="truncate">Evidence: {memory.evidenceText}</span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-1">
        <Button variant="ghost" onClick={onView} aria-label="View memory">
          <Eye className="size-4" strokeWidth={1.75} />
          Details
        </Button>
        {active ? (
          <>
            <Button variant="ghost" onClick={onEdit} aria-label="Edit memory">
              <Pencil className="size-4" strokeWidth={1.75} />
              Edit
            </Button>
            {memory.memoryClass === 'proposed_learning' ? (
              <>
                <Button variant="ghost" onClick={onVerify} aria-label="Verify learning">
                  <ShieldCheck className="size-4" strokeWidth={1.75} />
                  Verify
                </Button>
                <Button
                  variant="ghost"
                  onClick={onReject}
                  disabled={pending}
                  aria-label="Reject learning"
                >
                  <X className="size-4" strokeWidth={1.75} />
                  Reject
                </Button>
              </>
            ) : null}
            {memory.memoryClass !== 'temporary_context' ? (
              <Button variant="ghost" onClick={onSupersede} aria-label="Replace memory">
                <Replace className="size-4" strokeWidth={1.75} />
                Replace
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={onArchive}
              disabled={pending}
              aria-label="Archive memory"
            >
              <Archive className="size-4" strokeWidth={1.75} />
              Archive
            </Button>
          </>
        ) : memory.status === 'archived' ? (
          <Button
            variant="ghost"
            onClick={onRestore}
            disabled={pending}
            aria-label="Restore memory"
          >
            <ArchiveRestore className="size-4" strokeWidth={1.75} />
            Restore
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function MemoryDetailDialog({ memory, onClose }: { memory: MemoryListItem; onClose: () => void }) {
  return (
    <Modal title="Memory details" onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="whitespace-pre-wrap leading-6 text-zinc-800">{memory.content}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Detail label="Type" value={memory.typeLabel} />
          <Detail
            label="Status"
            value={
              memory.status !== 'active'
                ? memory.statusLabel
                : memory.freshness === 'expired'
                  ? 'Expired'
                  : 'Current'
            }
          />
          <Detail label="Applies to" value={memory.scopePath} />
          <Detail label="Source" value={memory.sourceLabel} />
          <Detail label="Confidence" value={memory.confidenceLabel ?? 'Not set'} />
          <Detail label="Created" value={formatMemoryDate(memory.createdAt)} />
          <Detail label="Verified" value={formatMemoryDate(memory.lastVerifiedAt)} />
          <Detail label="Expires" value={formatMemoryDate(memory.expiresAt)} />
        </div>
        {memory.evidenceText ? (
          <div className="rounded-md bg-zinc-50 px-3 py-2">
            <p className="text-xs font-medium text-zinc-500">Evidence</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">{memory.evidenceText}</p>
          </div>
        ) : null}
        {memory.supersededByContent ? (
          <div className="rounded-md bg-zinc-50 px-3 py-2">
            <p className="text-xs font-medium text-zinc-500">Replaced by</p>
            <p className="mt-1 text-sm text-zinc-700">{memory.supersededByContent}</p>
          </div>
        ) : null}
        {memory.replacesContent ? (
          <div className="rounded-md bg-zinc-50 px-3 py-2">
            <p className="text-xs font-medium text-zinc-500">Replaces</p>
            <p className="mt-1 text-sm text-zinc-700">{memory.replacesContent}</p>
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="mt-0.5 text-sm text-zinc-700">{value}</p>
    </div>
  )
}
