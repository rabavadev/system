import { Archive, Calendar, Edit3, FileText, Plus, Radio, Sparkles, Tag } from 'lucide-react'
import { useState, useTransition } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import type { CampaignDetail } from '~/server/db/campaign'
import type { CampaignContentItem, ContentStatus } from '~/types/domain'
import { CampaignContentModal } from './campaign-content-modal'
import { CampaignDraftModal } from './campaign-draft-modal'
import { archiveCampaignContentFn } from './server'

interface CampaignContentPlanProps {
  campaign: CampaignDetail
  onRefresh?: () => Promise<void> | void
}

type TabFilter = 'all' | 'idea' | 'planned' | 'draft' | 'ready'

function getStatusBadge(status: ContentStatus) {
  switch (status) {
    case 'idea':
      return <Badge tone="neutral">Idea</Badge>
    case 'planned':
      return <Badge tone="muted">Planned</Badge>
    case 'draft':
      return <Badge tone="warning">Draft</Badge>
    case 'ready':
      return <Badge tone="success">Ready</Badge>
    case 'in_review':
      return <Badge tone="warning">In Review</Badge>
    case 'approved':
      return <Badge tone="success">Approved</Badge>
    case 'archived':
      return <Badge tone="muted">Archived</Badge>
    default:
      return <Badge tone="neutral">{status}</Badge>
  }
}

function formatContentType(type: string): string {
  switch (type) {
    case 'short_form':
      return 'Short-form'
    case 'long_form':
      return 'Long-form'
    case 'image':
      return 'Image'
    case 'video':
      return 'Video'
    case 'thread':
      return 'Thread'
    case 'email':
      return 'Email'
    case 'other':
      return 'Other'
    default:
      return 'Post'
  }
}

export function CampaignContentPlan({ campaign, onRefresh }: CampaignContentPlanProps) {
  const [activeTab, setActiveTab] = useState<TabFilter>('all')
  const [modalItem, setModalItem] = useState<{ open: boolean; item: CampaignContentItem | null }>({
    open: false,
    item: null,
  })
  const [draftModalItem, setDraftModalItem] = useState<CampaignContentItem | null>(null)
  const [isArchiving, startArchiving] = useTransition()

  const items = campaign.contentItems ?? []

  const filteredItems = items.filter((item) => {
    if (activeTab === 'all') return item.status !== 'archived'
    return item.status === activeTab
  })

  const ideaCount = items.filter((i) => i.status === 'idea').length
  const plannedCount = items.filter((i) => i.status === 'planned').length
  const draftCount = items.filter((i) => i.status === 'draft').length
  const readyCount = items.filter((i) => i.status === 'ready').length
  const totalActive = items.filter((i) => i.status !== 'archived').length

  const handleArchive = (item: CampaignContentItem) => {
    if (!window.confirm(`Archive content item "${item.title}"?`)) return

    startArchiving(async () => {
      try {
        await archiveCampaignContentFn({
          data: {
            workspaceId: campaign.workspaceId,
            id: item.id,
          },
        })
        await onRefresh?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to archive item.')
      }
    })
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-xs overflow-hidden">
      {/* Header */}
      <div className="border-b border-zinc-200 px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-50/50">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-900">Campaign Content Plan</h2>
            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
              {totalActive} {totalActive === 1 ? 'item' : 'items'}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            Plan, organize, and assign creative content pieces to target accounts for this campaign.
          </p>
        </div>

        <Button onClick={() => setModalItem({ open: true, item: null })} className="shrink-0">
          <Plus className="size-3.5 mr-1" />
          Add Content Item
        </Button>
      </div>

      {/* Tabs */}
      <div className="border-b border-zinc-200 px-5 bg-white flex items-center justify-between overflow-x-auto">
        <div className="flex space-x-1 py-2">
          <button
            type="button"
            onClick={() => setActiveTab('all')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'all'
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            All ({totalActive})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('idea')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'idea'
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            Ideas ({ideaCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('planned')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'planned'
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            Planned ({plannedCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('draft')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'draft'
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            Drafts ({draftCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('ready')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'ready'
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            Ready ({readyCount})
          </button>
        </div>
      </div>

      {/* Content List */}
      <div className="p-0">
        {filteredItems.length === 0 ? (
          <div className="p-8 text-center text-zinc-500">
            <FileText className="mx-auto size-8 text-zinc-300 mb-2" />
            <p className="text-sm font-medium text-zinc-700">No content items in this view</p>
            <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
              {activeTab === 'all'
                ? 'Start building your campaign plan by adding ideas, drafts, and scheduled posts.'
                : `No items currently marked as "${activeTab}".`}
            </p>
            {activeTab === 'all' && (
              <Button
                variant="secondary"
                onClick={() => setModalItem({ open: true, item: null })}
                className="mt-4"
              >
                <Plus className="size-3.5 mr-1" />
                Add First Content Item
              </Button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-zinc-200">
            {filteredItems.map((item) => {
              const hasDraftVariant = (item.variantCount ?? 0) > 0 || item.status === 'draft'

              return (
                <div
                  key={item.id}
                  className="p-4 hover:bg-zinc-50/70 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-3"
                >
                  {/* Main details */}
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-900 truncate">
                        {item.title}
                      </span>
                      {getStatusBadge(item.status)}
                      {(item.variantCount ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 border border-emerald-200">
                          <Sparkles className="size-3" />
                          Draft Saved
                        </span>
                      )}
                      <span className="inline-flex items-center rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700 border border-zinc-200">
                        {formatContentType(item.contentType)}
                      </span>
                      {item.purpose && (
                        <span className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 border border-indigo-200">
                          {item.purpose}
                        </span>
                      )}
                    </div>

                    {/* Secondary metadata */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                      {item.theme && (
                        <div className="flex items-center gap-1">
                          <Tag className="size-3.5 text-zinc-400" />
                          <span>Theme: {item.theme}</span>
                        </div>
                      )}

                      {item.accountHandle ? (
                        <div className="flex items-center gap-1 text-zinc-700">
                          <Radio className="size-3.5 text-zinc-400" />
                          <span>
                            @{item.accountHandle.replace(/^@/, '')}
                            {item.platformName ? ` (${item.platformName})` : ''}
                          </span>
                        </div>
                      ) : (
                        <span className="text-zinc-400 italic">Unassigned account</span>
                      )}

                      {item.plannedAt && (
                        <div className="flex items-center gap-1 text-zinc-600">
                          <Calendar className="size-3.5 text-zinc-400" />
                          <span>Planned: {item.plannedAt.slice(0, 10)}</span>
                        </div>
                      )}
                    </div>

                    {item.brief && (
                      <p className="text-xs text-zinc-600 line-clamp-2 pt-0.5 bg-zinc-50/80 rounded px-2 py-1 border border-zinc-100">
                        {item.brief}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0 self-end md:self-center">
                    {/* Draft Action Button */}
                    <Button
                      variant={hasDraftVariant ? 'secondary' : 'secondary'}
                      onClick={() => setDraftModalItem(item)}
                      className={`h-8 px-2.5 text-xs ${
                        hasDraftVariant
                          ? 'text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border-indigo-200'
                          : 'text-zinc-700 hover:text-zinc-900'
                      }`}
                    >
                      <Sparkles className="size-3.5 mr-1 text-indigo-600" />
                      {hasDraftVariant ? 'View Draft' : 'Generate Draft'}
                    </Button>

                    <Button
                      variant="ghost"
                      onClick={() => setModalItem({ open: true, item })}
                      className="h-8 px-2.5 text-xs text-zinc-600 hover:text-zinc-900"
                    >
                      <Edit3 className="size-3.5 mr-1" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => handleArchive(item)}
                      disabled={isArchiving}
                      className="h-8 px-2.5 text-xs text-zinc-400 hover:text-red-600"
                      title="Archive Item"
                    >
                      <Archive className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Content Edit/Create Modal */}
      {modalItem.open && (
        <CampaignContentModal
          campaign={campaign}
          contentItem={modalItem.item}
          onClose={() => setModalItem({ open: false, item: null })}
          onSuccess={async () => {
            await onRefresh?.()
          }}
        />
      )}

      {/* Creator Draft Generation & Review Modal */}
      {draftModalItem && (
        <CampaignDraftModal
          campaign={campaign}
          contentItem={draftModalItem}
          onClose={() => setDraftModalItem(null)}
          onSuccess={async () => {
            await onRefresh?.()
          }}
        />
      )}
    </div>
  )
}
