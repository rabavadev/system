import { Link, useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Edit3,
  ExternalLink,
  FlaskConical,
  Globe,
  Layers,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react'
import { useState, useTransition } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { CampaignFormModal } from '~/features/campaigns/campaign-form-modal'
import {
  activateCampaignFn,
  archiveCampaignFn,
  completeCampaignFn,
  pauseCampaignFn,
  restoreCampaignFn,
} from '~/features/campaigns/server'
import type { AccountSummary } from '~/server/db/account'
import type { CampaignDetail } from '~/server/db/campaign'
import type { ProductSummary } from '~/server/db/product'
import type { Brand, CampaignStatus } from '~/types/domain'

interface CampaignDetailPageProps {
  campaign: CampaignDetail
  brands: Brand[]
  productsByBrand: Record<string, ProductSummary[]>
  allAccounts: AccountSummary[]
}

function statusTone(status: CampaignStatus): 'success' | 'warning' | 'muted' | 'neutral' {
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
  if (!iso) return 'Not set'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return 'Not set'
  }
}

export function CampaignDetailPage({
  campaign,
  brands,
  productsByBrand,
  allAccounts,
}: CampaignDetailPageProps) {
  const router = useRouter()
  const [showEditModal, setShowEditModal] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleStatusChange(fn: (args: { data: { id: string } }) => Promise<unknown>) {
    startTransition(async () => {
      await fn({ data: { id: campaign.id } })
      await router.invalidate()
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      {/* Breadcrumb & Top Bar */}
      <div className="flex flex-col gap-3">
        <Link
          to="/campaigns"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-900 transition-colors w-fit"
        >
          <ArrowLeft className="size-3.5" />
          Back to Campaigns
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight text-zinc-900">{campaign.name}</h1>
              <Badge tone={statusTone(campaign.status)}>
                {campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1)}
              </Badge>
            </div>
            <p className="text-xs text-zinc-500">
              Brand: <span className="font-medium text-zinc-800">{campaign.brandName}</span>
              {campaign.productName ? (
                <>
                  {' '}
                  · Target Product:{' '}
                  <span className="font-medium text-zinc-800">{campaign.productName}</span>
                </>
              ) : null}
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {campaign.status === 'draft' && (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => handleStatusChange(activateCampaignFn)}
                className="text-xs text-emerald-700 hover:text-emerald-800 px-2.5 py-1"
              >
                <Play className="size-3.5 mr-1" />
                Activate campaign
              </Button>
            )}
            {campaign.status === 'active' && (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => handleStatusChange(pauseCampaignFn)}
                className="text-xs text-amber-700 hover:text-amber-800 px-2.5 py-1"
              >
                <Pause className="size-3.5 mr-1" />
                Pause
              </Button>
            )}
            {campaign.status === 'paused' && (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => handleStatusChange(activateCampaignFn)}
                className="text-xs text-emerald-700 hover:text-emerald-800 px-2.5 py-1"
              >
                <Play className="size-3.5 mr-1" />
                Resume
              </Button>
            )}
            {(campaign.status === 'active' || campaign.status === 'paused') && (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => handleStatusChange(completeCampaignFn)}
                className="text-xs text-zinc-700 hover:text-zinc-900 px-2.5 py-1"
              >
                <CheckCircle2 className="size-3.5 mr-1" />
                Mark completed
              </Button>
            )}
            {campaign.status !== 'archived' ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setShowEditModal(true)}
                  className="text-xs px-2.5 py-1"
                >
                  <Edit3 className="size-3.5 mr-1" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => handleStatusChange(archiveCampaignFn)}
                  className="text-xs text-zinc-500 hover:text-red-600 px-2 py-1"
                >
                  <Archive className="size-3.5 mr-1" />
                  Archive
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => handleStatusChange(restoreCampaignFn)}
                className="text-xs text-blue-700 px-2.5 py-1"
              >
                <RotateCcw className="size-3.5 mr-1" />
                Restore campaign
              </Button>
            )}
            <Link
              to="/chat"
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800"
            >
              <MessageSquare className="size-3.5" />
              Chat
            </Link>
          </div>
        </div>
      </div>

      {/* Grid Layout */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {/* Left Column (2 spans): Overview & Details */}
        <div className="space-y-6 md:col-span-2">
          {/* Objective & Description */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs">
            <h2 className="text-sm font-semibold text-zinc-900 mb-3 flex items-center gap-2">
              <Layers className="size-4 text-zinc-500" />
              Campaign Objective & Angle
            </h2>
            {campaign.angle ? (
              <p className="text-sm leading-relaxed text-zinc-700 whitespace-pre-wrap">
                {campaign.angle}
              </p>
            ) : (
              <p className="text-xs text-zinc-400 italic">
                No specific objective or angle notes provided for this campaign.
              </p>
            )}

            {campaign.audience && (
              <div className="mt-4 border-t border-zinc-100 pt-3">
                <span className="text-xs font-medium text-zinc-500">Target Audience:</span>
                <p className="text-xs text-zinc-800 mt-0.5">{campaign.audience}</p>
              </div>
            )}
          </div>

          {/* Connected Accounts */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <Globe className="size-4 text-zinc-500" />
                Connected Accounts ({campaign.accounts.length})
              </h2>
              <Button
                variant="ghost"
                onClick={() => setShowEditModal(true)}
                className="text-xs text-blue-600 hover:text-blue-700 h-7 px-2 py-0.5"
              >
                Manage accounts
              </Button>
            </div>

            {campaign.accounts.length === 0 ? (
              <p className="text-xs text-zinc-400 italic">
                No social or publishing accounts attached to this campaign yet.
              </p>
            ) : (
              <div className="divide-y divide-zinc-100">
                {campaign.accounts.map((acc) => (
                  <div key={acc.id} className="flex items-center justify-between py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-7 items-center justify-center rounded bg-zinc-100 text-xs font-semibold text-zinc-700">
                        {acc.platformName.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <Link
                          to="/accounts/$accountId"
                          params={{ accountId: acc.id }}
                          className="text-xs font-semibold text-zinc-900 hover:text-blue-600 hover:underline"
                        >
                          {acc.handle}
                        </Link>
                        <p className="text-[11px] text-zinc-400">{acc.platformName}</p>
                      </div>
                    </div>
                    <Badge tone={acc.status === 'active' ? 'success' : 'muted'}>{acc.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Relevant Research */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <FlaskConical className="size-4 text-zinc-500" />
                Relevant Research ({campaign.researchCount})
              </h2>
              <Link
                to="/research"
                className="text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline inline-flex items-center gap-1"
              >
                Open Research
                <ExternalLink className="size-3" />
              </Link>
            </div>

            {campaign.recentResearch.length === 0 ? (
              <p className="text-xs text-zinc-400 italic">
                No linked research records yet. Research conducted under this brand or campaign will
                appear here.
              </p>
            ) : (
              <div className="divide-y divide-zinc-100">
                {campaign.recentResearch.map((res) => (
                  <div key={res.id} className="flex items-center justify-between py-2 text-xs">
                    <span className="font-medium text-zinc-800 truncate max-w-md">
                      {res.subject}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 uppercase font-medium">
                        {res.researchType}
                      </span>
                      <Badge tone={res.status === 'completed' ? 'success' : 'muted'}>
                        {res.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Metadata & Details */}
        <div className="space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Campaign Parameters
            </h2>

            <div className="space-y-3 text-xs">
              <div>
                <span className="text-zinc-400 block mb-0.5">Brand</span>
                <span className="font-medium text-zinc-900">{campaign.brandName}</span>
              </div>

              <div>
                <span className="text-zinc-400 block mb-0.5">Target Product</span>
                {campaign.productName && campaign.productId ? (
                  <Link
                    to="/products/$productId"
                    params={{ productId: campaign.productId }}
                    className="font-medium text-blue-600 hover:underline"
                  >
                    {campaign.productName}
                  </Link>
                ) : (
                  <span className="text-zinc-500">General Brand Campaign</span>
                )}
              </div>

              <div className="border-t border-zinc-100 pt-3">
                <span className="text-zinc-400 block mb-0.5">Timeline</span>
                <div className="flex items-center gap-1.5 text-zinc-700 font-medium">
                  <Calendar className="size-3.5 text-zinc-400" />
                  <span>
                    {formatDate(campaign.startsAt)} – {formatDate(campaign.endsAt)}
                  </span>
                </div>
              </div>

              <div className="border-t border-zinc-100 pt-3 text-[11px] text-zinc-400 space-y-1">
                <div>Created: {formatDate(campaign.createdAt)}</div>
                <div>Last updated: {formatDate(campaign.updatedAt)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {showEditModal && (
        <CampaignFormModal
          brands={brands}
          productsByBrand={productsByBrand}
          allAccounts={allAccounts}
          campaign={campaign}
          onClose={() => setShowEditModal(false)}
        />
      )}
    </div>
  )
}
