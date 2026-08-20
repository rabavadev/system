import { Link, useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Compass,
  Edit3,
  Globe,
  Info,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  Sliders,
  Sparkles,
  Star,
  Target,
  Users,
} from 'lucide-react'
import { useState, useTransition } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { CampaignContentPlan } from '~/features/campaigns/campaign-content-plan'
import { CampaignFormModal } from '~/features/campaigns/campaign-form-modal'
import { CampaignResearchSection } from '~/features/campaigns/campaign-research-section'
import { CampaignStrategyModal } from '~/features/campaigns/campaign-strategy-modal'
import { CampaignTargetsModal } from '~/features/campaigns/campaign-targets-modal'
import { CampaignWorkflowsSection } from '~/features/campaigns/campaign-workflows-section'
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
import type { Brand, CampaignObjective, CampaignPriority, CampaignStatus } from '~/types/domain'

interface CampaignDetailPageProps {
  campaign: CampaignDetail
  brands: Brand[]
  productsByBrand: Record<string, ProductSummary[]>
  allAccounts: AccountSummary[]
  activeWorkflows?: Array<{ id: string; name: string; description: string | null }>
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

function priorityTone(priority: CampaignPriority): 'warning' | 'neutral' | 'muted' {
  switch (priority) {
    case 'high':
      return 'warning'
    case 'normal':
      return 'neutral'
    case 'low':
      return 'muted'
  }
}

const OBJECTIVE_LABELS: Record<CampaignObjective, string> = {
  revenue: 'Revenue',
  conversions: 'Sales / Conversions',
  traffic: 'Qualified Traffic',
  leads: 'Leads / Signups',
  awareness: 'Awareness',
  engagement: 'Engagement',
  retention: 'Retention',
  validation: 'Validation / Learning',
}

const METRIC_LABELS: Record<string, string> = {
  revenue: 'Revenue',
  conversions: 'Sales / Conversions',
  orders: 'Orders',
  conversion_rate: 'Conversion Rate',
  qualified_visits: 'Qualified Visits',
  clicks: 'Clicks',
  outbound_clicks: 'Outbound Clicks',
  ctr: 'Click-Through Rate (CTR)',
  leads: 'Leads / Signups',
  saves: 'Saves',
  engagements: 'Engagements',
  impressions: 'Impressions',
}

const AWARENESS_LABELS: Record<string, string> = {
  unaware: 'Unaware',
  problem_aware: 'Problem-Aware',
  solution_aware: 'Solution-Aware',
  product_aware: 'Product-Aware',
  most_aware: 'Most Aware',
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

function formatNumber(val: number): string {
  return new Intl.NumberFormat().format(val)
}

export function CampaignDetailPage({
  campaign,
  brands,
  productsByBrand,
  allAccounts,
  activeWorkflows = [],
}: CampaignDetailPageProps) {
  const router = useRouter()
  const [showEditModal, setShowEditModal] = useState(false)
  const [showStrategyModal, setShowStrategyModal] = useState(false)
  const [showTargetsModal, setShowTargetsModal] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleStatusChange(fn: (args: { data: { id: string } }) => Promise<unknown>) {
    startTransition(async () => {
      await fn({ data: { id: campaign.id } })
      await router.invalidate()
    })
  }

  const hasAudience = Boolean(
    campaign.audienceDetails?.summary ||
      campaign.audienceDetails?.problem ||
      campaign.audienceDetails?.awarenessLevel ||
      campaign.audienceDetails?.geography,
  )

  const hasStrategy = Boolean(
    campaign.strategy?.positioning ||
      campaign.strategy?.coreAngle ||
      campaign.strategy?.offerMessage ||
      campaign.strategy?.hypothesis ||
      campaign.angle,
  )

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
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight text-zinc-900">{campaign.name}</h1>
              <Badge tone={statusTone(campaign.status)}>
                {campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1)}
              </Badge>
              {campaign.objective ? (
                <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 border border-blue-200/60 inline-flex items-center gap-1">
                  <Target className="size-3" />
                  {OBJECTIVE_LABELS[campaign.objective] ?? campaign.objective}
                </span>
              ) : null}
              <Badge tone={priorityTone(campaign.priority)}>
                {campaign.priority.toUpperCase()} PRIORITY
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
        {/* Left Column (2 spans): Strategy, Success Targets, Details */}
        <div className="space-y-6 md:col-span-2">
          {/* Section 1: Strategy & Audience Definition */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
              <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <Compass className="size-4 text-zinc-600" />
                Strategic Direction & Audience
              </h2>
              <Button
                variant="secondary"
                onClick={() => setShowStrategyModal(true)}
                className="text-xs h-7 px-2.5"
              >
                <Edit3 className="size-3.5 mr-1" />
                Edit Strategy
              </Button>
            </div>

            {/* Strategy Grid */}
            <div className="grid grid-cols-1 gap-4 text-xs">
              {/* Primary Objective Banner */}
              <div className="rounded-md bg-zinc-50 p-3 border border-zinc-200/70 flex items-start gap-3">
                <div className="rounded-full bg-blue-100 p-1.5 text-blue-700 shrink-0">
                  <Target className="size-4" />
                </div>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-900">Primary Objective:</span>
                    <span className="font-medium text-blue-700">
                      {campaign.objective ? OBJECTIVE_LABELS[campaign.objective] : 'Not specified'}
                    </span>
                  </div>
                  <p className="text-zinc-500 text-[11px]">
                    Guides strategic focus for content creation and distribution.
                  </p>
                </div>
              </div>

              {/* Audience Sub-card */}
              <div className="rounded-md border border-zinc-200/80 p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-800 flex items-center gap-1.5">
                    <Users className="size-3.5 text-zinc-500" />
                    Target Audience
                  </span>
                  {campaign.audienceDetails?.awarenessLevel && (
                    <span className="rounded bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-700 border border-purple-200">
                      {AWARENESS_LABELS[campaign.audienceDetails.awarenessLevel] ??
                        campaign.audienceDetails.awarenessLevel}
                    </span>
                  )}
                </div>

                {hasAudience ? (
                  <div className="space-y-2 pt-1 text-zinc-700">
                    {campaign.audienceDetails?.summary && (
                      <p className="font-medium text-zinc-900">
                        {campaign.audienceDetails.summary}
                      </p>
                    )}
                    {campaign.audienceDetails?.problem && (
                      <div>
                        <span className="text-zinc-400 block text-[11px]">
                          Problem / Core Need:
                        </span>
                        <p className="text-zinc-700">{campaign.audienceDetails.problem}</p>
                      </div>
                    )}
                    {campaign.audienceDetails?.geography && (
                      <div className="text-[11px] text-zinc-500">
                        Geography:{' '}
                        <span className="text-zinc-800 font-medium">
                          {campaign.audienceDetails.geography}
                        </span>
                      </div>
                    )}
                    {campaign.audienceDetails?.notes && (
                      <div className="text-[11px] text-zinc-500 italic bg-zinc-50 p-2 rounded">
                        Notes: {campaign.audienceDetails.notes}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-zinc-400 italic">No detailed audience defined yet.</p>
                )}
              </div>

              {/* Strategic Direction Sub-card */}
              <div className="rounded-md border border-zinc-200/80 p-3.5 space-y-3">
                <span className="font-semibold text-zinc-800 flex items-center gap-1.5">
                  <Sliders className="size-3.5 text-zinc-500" />
                  Strategy & Messaging
                </span>

                {hasStrategy ? (
                  <div className="space-y-2.5 pt-1">
                    {campaign.strategy?.positioning && (
                      <div>
                        <span className="text-zinc-400 block text-[11px]">Positioning & Hook:</span>
                        <p className="text-zinc-800 font-medium">{campaign.strategy.positioning}</p>
                      </div>
                    )}

                    {(campaign.strategy?.coreAngle || campaign.angle) && (
                      <div>
                        <span className="text-zinc-400 block text-[11px]">
                          Core Creative Angle:
                        </span>
                        <p className="text-zinc-800 font-medium">
                          {campaign.strategy?.coreAngle || campaign.angle}
                        </p>
                      </div>
                    )}

                    {campaign.strategy?.offerMessage && (
                      <div>
                        <span className="text-zinc-400 block text-[11px]">
                          Offer / Key Message:
                        </span>
                        <p className="text-zinc-800 font-medium">
                          {campaign.strategy.offerMessage}
                        </p>
                      </div>
                    )}

                    {campaign.strategy?.hypothesis && (
                      <div className="rounded bg-amber-50/60 border border-amber-200/60 p-2.5">
                        <span className="text-amber-800 block text-[11px] font-semibold flex items-center gap-1">
                          <Sparkles className="size-3 text-amber-600" />
                          Key Strategic Hypothesis:
                        </span>
                        <p className="text-amber-900 text-xs mt-0.5 font-medium">
                          {campaign.strategy.hypothesis}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-zinc-400 italic">
                    No specific strategy direction defined yet.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Section 2: Success Metrics & KPI Targets */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
              <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <Target className="size-4 text-zinc-600" />
                Success Metrics & Targets
              </h2>
              <Button
                variant="secondary"
                onClick={() => setShowTargetsModal(true)}
                className="text-xs h-7 px-2.5"
              >
                <Sliders className="size-3.5 mr-1" />
                Configure Targets
              </Button>
            </div>

            {campaign.targets.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-xs text-zinc-500">
                <p className="mb-2">No success targets or KPIs configured for this campaign.</p>
                <Button
                  variant="secondary"
                  onClick={() => setShowTargetsModal(true)}
                  className="text-xs"
                >
                  Set KPI Targets
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Primary KPI Card */}
                {campaign.primaryTarget && (
                  <div className="rounded-lg bg-gradient-to-r from-amber-50 to-orange-50/40 border border-amber-200 p-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-amber-900 inline-flex items-center gap-1.5">
                        <Star className="size-3.5 fill-amber-500 text-amber-600" />
                        PRIMARY KPI
                      </span>
                      <span className="text-[11px] font-medium text-amber-700 uppercase">
                        North Star Target
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-xl font-bold text-zinc-900">
                        {formatNumber(campaign.primaryTarget.targetValue)}
                        {campaign.primaryTarget.unit ? ` ${campaign.primaryTarget.unit}` : ''}
                      </span>
                      <span className="text-xs font-medium text-zinc-600">
                        {METRIC_LABELS[campaign.primaryTarget.metricKey] ??
                          campaign.primaryTarget.metricKey}
                      </span>
                    </div>
                  </div>
                )}

                {/* Supporting Metrics */}
                {campaign.supportingTargets.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-600 mb-2">Supporting Metrics</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {campaign.supportingTargets.map((t) => (
                        <div
                          key={t.id}
                          className="rounded-md border border-zinc-200 bg-zinc-50/50 p-3 flex flex-col justify-between"
                        >
                          <span className="text-xs text-zinc-500 font-medium">
                            {METRIC_LABELS[t.metricKey] ?? t.metricKey}
                          </span>
                          <span className="text-base font-semibold text-zinc-900 mt-1">
                            {formatNumber(t.targetValue)}
                            {t.unit ? ` ${t.unit}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Integrity Notice (no fake performance progress) */}
                <div className="rounded-md bg-zinc-50 p-3 text-[11px] text-zinc-500 border border-zinc-200/60 flex items-center gap-2">
                  <Info className="size-3.5 text-zinc-400 shrink-0" />
                  <span>
                    Performance data not connected yet. Real metrics will appear once analytics
                    tracking is enabled.
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Section 3: Campaign Content Plan */}
          <CampaignContentPlan
            campaign={campaign}
            onRefresh={async () => {
              await router.invalidate()
            }}
          />

          {/* Section 4: Connected Accounts */}
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

          {/* Section 4: Campaign Research */}
          <CampaignResearchSection campaign={campaign} />

          {/* Section 5: Campaign Workflows & Execution */}
          <CampaignWorkflowsSection
            campaign={campaign}
            activeWorkflows={activeWorkflows}
            onRefresh={async () => {
              await router.invalidate()
            }}
          />
        </div>

        {/* Right Column: Parameters & Summary */}
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

              <div>
                <span className="text-zinc-400 block mb-0.5">Priority</span>
                <Badge tone={priorityTone(campaign.priority)}>
                  {campaign.priority.toUpperCase()}
                </Badge>
              </div>

              {campaign.objective && (
                <div>
                  <span className="text-zinc-400 block mb-0.5">Primary Objective</span>
                  <span className="font-medium text-zinc-900">
                    {OBJECTIVE_LABELS[campaign.objective]}
                  </span>
                </div>
              )}

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

      {/* Edit General Modal */}
      {showEditModal && (
        <CampaignFormModal
          brands={brands}
          productsByBrand={productsByBrand}
          allAccounts={allAccounts}
          campaign={campaign}
          onClose={() => setShowEditModal(false)}
        />
      )}

      {/* Strategy Modal */}
      {showStrategyModal && (
        <CampaignStrategyModal
          campaign={campaign}
          onClose={() => setShowStrategyModal(false)}
          onSuccess={async () => {
            await router.invalidate()
          }}
        />
      )}

      {/* Targets Modal */}
      {showTargetsModal && (
        <CampaignTargetsModal
          campaign={campaign}
          onClose={() => setShowTargetsModal(false)}
          onSuccess={async () => {
            await router.invalidate()
          }}
        />
      )}
    </div>
  )
}
