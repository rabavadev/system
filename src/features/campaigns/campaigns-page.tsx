import { useQuery } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { Archive, CheckCircle2, Edit3, Megaphone, Pause, Play, Plus, RotateCcw } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/empty-state'
import { inputClass } from '~/components/ui/form'
import { CampaignFormModal } from '~/features/campaigns/campaign-form-modal'
import {
  activateCampaignFn,
  archiveCampaignFn,
  completeCampaignFn,
  getCampaignsPageData,
  pauseCampaignFn,
  restoreCampaignFn,
} from '~/features/campaigns/server'
import type { CampaignSummary } from '~/server/db/campaign'
import type { CampaignStatus } from '~/types/domain'

function campaignStatusTone(status: CampaignStatus): 'success' | 'warning' | 'muted' | 'neutral' {
  switch (status) {
    case 'active':
      return 'success'
    case 'paused':
      return 'warning'
    case 'draft':
      return 'muted'
    case 'completed':
      return 'neutral'
    case 'archived':
      return 'muted'
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return '—'
  }
}

export function CampaignsPage() {
  const router = useRouter()
  const [selectedBrandId, setSelectedBrandId] = useState<string>('')
  const [selectedProductId, setSelectedProductId] = useState<string>('')
  const [selectedStatus, setSelectedStatus] = useState<string>('')
  const [showModal, setShowModal] = useState(false)
  const [editingCampaign, setEditingCampaign] = useState<CampaignSummary | undefined>()
  const [showArchived, setShowArchived] = useState(false)
  const [pending, startTransition] = useTransition()

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', selectedBrandId, selectedProductId, selectedStatus],
    queryFn: () =>
      getCampaignsPageData({
        data: {
          brandId: selectedBrandId || undefined,
          productId: selectedProductId || undefined,
          status: (selectedStatus as CampaignStatus) || undefined,
        },
      }),
  })

  const brands = data?.brands ?? []
  const campaigns = data?.campaigns ?? []
  const archivedCampaigns = data?.archivedCampaigns ?? []
  const productsByBrand = data?.productsByBrand ?? {}
  const allAccounts = data?.allAccounts ?? []

  const availableProducts = selectedBrandId ? (productsByBrand[selectedBrandId] ?? []) : []

  function handleStatusChange(
    fn: (args: { data: { id: string } }) => Promise<unknown>,
    id: string,
  ) {
    startTransition(async () => {
      await fn({ data: { id } })
      await router.invalidate()
    })
  }

  if (!isLoading && brands.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">
        <PageHeader title="Campaigns" description="The growth campaigns you run." />
        <EmptyState
          icon={Megaphone}
          title="Create a brand first"
          description="Campaigns belong to a brand. Create your first brand before creating a campaign."
          action={
            <Link
              to="/brands"
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
            >
              Go to Brands
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title="Campaigns"
          description="Manage growth initiatives, coordinated product launches, and multi-account publishing campaigns."
        />
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              setEditingCampaign(undefined)
              setShowModal(true)
            }}
            className="inline-flex items-center gap-1.5"
          >
            <Plus className="size-4" />
            New campaign
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-zinc-200 bg-white p-3 shadow-xs">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-500">Brand:</span>
          <select
            value={selectedBrandId}
            onChange={(e) => {
              setSelectedBrandId(e.target.value)
              setSelectedProductId('')
            }}
            className={inputClass}
          >
            <option value="">All brands</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        {selectedBrandId && availableProducts.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-zinc-500">Product:</span>
            <select
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value)}
              className={inputClass}
            >
              <option value="">All products</option>
              {availableProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-500">Status:</span>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className={inputClass}
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        {archivedCampaigns.length > 0 && (
          <div className="ml-auto">
            <Button
              variant="ghost"
              onClick={() => setShowArchived(!showArchived)}
              className="text-xs text-zinc-500 hover:text-zinc-900 px-2 py-1"
            >
              <Archive className="size-3.5 mr-1" />
              {showArchived ? 'Hide archived' : `Archived (${archivedCampaigns.length})`}
            </Button>
          </div>
        )}
      </div>

      {/* Campaigns Table */}
      {campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns found"
          description={
            selectedBrandId || selectedStatus || selectedProductId
              ? 'No campaigns match your selected filters. Try clearing your filters or create a new campaign.'
              : 'Create your first campaign to coordinate product promotions, content schedules, and multi-channel publishing.'
          }
          action={
            <Button
              onClick={() => {
                setEditingCampaign(undefined)
                setShowModal(true)
              }}
            >
              <Plus className="size-4 mr-1.5" />
              Create campaign
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-zinc-600">
              <thead className="border-b border-zinc-100 bg-zinc-50/70 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-4 py-3">Campaign</th>
                  <th className="px-4 py-3">Brand</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Accounts</th>
                  <th className="px-4 py-3">Dates</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {campaigns.map((c) => (
                  <tr key={c.id} className="hover:bg-zinc-50/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      <Link
                        to="/campaigns/$campaignId"
                        params={{ campaignId: c.id }}
                        className="hover:text-blue-600 hover:underline block max-w-xs truncate font-semibold"
                      >
                        {c.name}
                      </Link>
                      {c.angle ? (
                        <p className="mt-0.5 max-w-xs truncate text-[11px] text-zinc-400 font-normal">
                          {c.angle}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
                        {c.brandName}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {c.productName ? (
                        <span className="inline-flex items-center rounded-md bg-blue-50 px-2 py-0.5 text-xs text-blue-700 border border-blue-200/50">
                          {c.productName}
                        </span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={campaignStatusTone(c.status)}>
                        {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {c.accountCount > 0 ? (
                        <span className="text-zinc-700 text-xs font-medium">
                          {c.accountCount} {c.accountCount === 1 ? 'account' : 'accounts'}
                        </span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-[11px]">
                      {c.startsAt || c.endsAt ? (
                        <span>
                          {formatDate(c.startsAt)}
                          {c.endsAt ? ` – ${formatDate(c.endsAt)}` : ''}
                        </span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {c.status === 'draft' && (
                          <Button
                            variant="ghost"
                            title="Activate campaign"
                            disabled={pending}
                            onClick={() => handleStatusChange(activateCampaignFn, c.id)}
                            className="text-xs text-emerald-600 hover:text-emerald-700 px-1.5 py-1"
                          >
                            <Play className="size-3.5 mr-1" />
                            Activate
                          </Button>
                        )}
                        {c.status === 'active' && (
                          <Button
                            variant="ghost"
                            title="Pause campaign"
                            disabled={pending}
                            onClick={() => handleStatusChange(pauseCampaignFn, c.id)}
                            className="text-xs text-amber-600 hover:text-amber-700 px-1.5 py-1"
                          >
                            <Pause className="size-3.5 mr-1" />
                            Pause
                          </Button>
                        )}
                        {c.status === 'paused' && (
                          <Button
                            variant="ghost"
                            title="Resume campaign"
                            disabled={pending}
                            onClick={() => handleStatusChange(activateCampaignFn, c.id)}
                            className="text-xs text-emerald-600 hover:text-emerald-700 px-1.5 py-1"
                          >
                            <Play className="size-3.5 mr-1" />
                            Resume
                          </Button>
                        )}
                        {(c.status === 'active' || c.status === 'paused') && (
                          <Button
                            variant="ghost"
                            title="Complete campaign"
                            disabled={pending}
                            onClick={() => handleStatusChange(completeCampaignFn, c.id)}
                            className="text-xs text-zinc-600 hover:text-zinc-900 px-1.5 py-1"
                          >
                            <CheckCircle2 className="size-3.5 mr-1" />
                            Complete
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          title="Edit campaign"
                          onClick={() => {
                            setEditingCampaign(c)
                            setShowModal(true)
                          }}
                          className="text-xs px-1.5 py-1 text-zinc-500 hover:text-zinc-900"
                        >
                          <Edit3 className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          title="Archive campaign"
                          disabled={pending}
                          onClick={() => handleStatusChange(archiveCampaignFn, c.id)}
                          className="text-xs px-1.5 py-1 text-zinc-400 hover:text-red-600"
                        >
                          <Archive className="size-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Archived Campaigns Section */}
      {showArchived && archivedCampaigns.length > 0 && (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50/50 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
            Archived Campaigns ({archivedCampaigns.length})
          </h3>
          <div className="divide-y divide-zinc-200">
            {archivedCampaigns.map((ac) => (
              <div key={ac.id} className="flex items-center justify-between py-2 text-xs">
                <div>
                  <span className="font-medium text-zinc-700">{ac.name}</span>
                  <span className="ml-2 text-zinc-400">({ac.brandName})</span>
                </div>
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => handleStatusChange(restoreCampaignFn, ac.id)}
                  className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1"
                >
                  <RotateCcw className="size-3.5 mr-1" />
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <CampaignFormModal
          brands={brands}
          productsByBrand={productsByBrand}
          allAccounts={allAccounts}
          campaign={editingCampaign}
          defaultBrandId={selectedBrandId || brands[0]?.id}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  )
}
