import { Link, useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Compass,
  Edit3,
  Globe,
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
import type { CampaignAccountItem, CampaignDetail } from '~/server/db/campaign'
import type { ProductSummary } from '~/server/db/product'
import type {
  Brand,
  CampaignObjective,
  CampaignPriority,
  CampaignStatus,
  CampaignTarget,
  MetricDefinition,
} from '~/types/domain'

interface CampaignDetailPageProps {
  campaign: CampaignDetail
  brands: Brand[]
  productsByBrand: Record<string, ProductSummary[]>
  allAccounts: AccountSummary[]
  activeWorkflows?: Array<{ id: string; name: string; description: string | null }>
  metricDefinitions?: MetricDefinition[]
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
  metricDefinitions = [],
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
      {/* Top Bar: Back, Status, Actions */}
      <div className="flex flex-col gap-4 border-b border-zinc-200 pb-5">
        <div className="flex items-center justify-between">
          <Link
            to="/campaigns"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
          >
            <ArrowLeft className="size-3.5" />
            Back to Campaigns
          </Link>
          <span className="text-xs text-zinc-400 font-mono">ID: {campaign.id.slice(0, 8)}...</span>
        </div>

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
                  {OBJECTIVE_LABELS[campaign.objective as CampaignObjective] ?? campaign.objective}
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
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="secondary"
              onClick={() => setShowEditModal(true)}
              className="gap-1.5 text-xs px-2.5 py-1"
            >
              <Edit3 className="size-3.5" />
              Edit
            </Button>

            {/* Lifecycle transitions */}
            {campaign.status === 'draft' && (
              <Button
                variant="primary"
                onClick={() => handleStatusChange(activateCampaignFn)}
                disabled={pending}
                className="gap-1.5 text-xs px-2.5 py-1 bg-green-600 hover:bg-green-700 text-white"
              >
                <Play className="size-3.5" />
                Activate
              </Button>
            )}

            {campaign.status === 'active' && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => handleStatusChange(pauseCampaignFn)}
                  disabled={pending}
                  className="gap-1.5 text-xs px-2.5 py-1"
                >
                  <Pause className="size-3.5" />
                  Pause
                </Button>
                <Button
                  variant="primary"
                  onClick={() => handleStatusChange(completeCampaignFn)}
                  disabled={pending}
                  className="gap-1.5 text-xs px-2.5 py-1"
                >
                  <CheckCircle2 className="size-3.5" />
                  Complete
                </Button>
              </>
            )}

            {campaign.status === 'paused' && (
              <>
                <Button
                  variant="primary"
                  onClick={() => handleStatusChange(activateCampaignFn)}
                  disabled={pending}
                  className="gap-1.5 text-xs px-2.5 py-1 bg-green-600 hover:bg-green-700 text-white"
                >
                  <Play className="size-3.5" />
                  Resume
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => handleStatusChange(completeCampaignFn)}
                  disabled={pending}
                  className="gap-1.5 text-xs px-2.5 py-1"
                >
                  <CheckCircle2 className="size-3.5" />
                  Complete
                </Button>
              </>
            )}

            {campaign.status === 'completed' && (
              <Button
                variant="secondary"
                onClick={() => handleStatusChange(restoreCampaignFn)}
                disabled={pending}
                className="gap-1.5 text-xs px-2.5 py-1"
              >
                <RotateCcw className="size-3.5" />
                Reopen
              </Button>
            )}

            {campaign.status !== 'archived' && (
              <Button
                variant="ghost"
                onClick={() => handleStatusChange(archiveCampaignFn)}
                disabled={pending}
                className="gap-1.5 text-xs px-2.5 py-1 text-zinc-500 hover:text-red-600 hover:bg-red-50"
              >
                <Archive className="size-3.5" />
                Archive
              </Button>
            )}

            {campaign.status === 'archived' && (
              <Button
                variant="secondary"
                onClick={() => handleStatusChange(restoreCampaignFn)}
                disabled={pending}
                className="gap-1.5 text-xs px-2.5 py-1 text-green-700 hover:bg-green-50"
              >
                <RotateCcw className="size-3.5" />
                Restore to Draft
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Main Grid: 2/3 Content & Planning, 1/3 Strategy & Meta */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left Column: Sections & Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Section 1: Campaign Strategy & Alignment */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <Compass className="size-4 text-blue-600" />
                Strategy & Audience
              </h2>
              <Button
                variant="ghost"
                onClick={() => setShowStrategyModal(true)}
                className="text-xs text-blue-600 hover:text-blue-700 h-7 px-2 py-0.5"
              >
                Edit Strategy
              </Button>
            </div>

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
                      {campaign.objective
                        ? (OBJECTIVE_LABELS[campaign.objective as CampaignObjective] ??
                          campaign.objective)
                        : 'Not specified'}
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
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 border border-amber-200">
                      {AWARENESS_LABELS[campaign.audienceDetails.awarenessLevel] ??
                        campaign.audienceDetails.awarenessLevel}
                    </span>
                  )}
                </div>
                {hasAudience ? (
                  <div className="space-y-1.5 text-zinc-600">
                    {campaign.audienceDetails?.summary && (
                      <p>
                        <span className="font-medium text-zinc-700">Summary:</span>{' '}
                        {campaign.audienceDetails.summary}
                      </p>
                    )}
                    {campaign.audienceDetails?.problem && (
                      <p>
                        <span className="font-medium text-zinc-700">Pain Point / Need:</span>{' '}
                        {campaign.audienceDetails.problem}
                      </p>
                    )}
                    {campaign.audienceDetails?.geography && (
                      <p>
                        <span className="font-medium text-zinc-700">Geography / Market:</span>{' '}
                        {campaign.audienceDetails.geography}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-zinc-400 italic">No specific audience defined yet.</p>
                )}
              </div>

              {/* Strategy & Message Sub-card */}
              <div className="rounded-md border border-zinc-200/80 p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-800 flex items-center gap-1.5">
                    <Sparkles className="size-3.5 text-zinc-500" />
                    Core Angle & Offer
                  </span>
                </div>
                {hasStrategy ? (
                  <div className="space-y-1.5 text-zinc-600">
                    {campaign.strategy?.positioning && (
                      <p>
                        <span className="font-medium text-zinc-700">Positioning:</span>{' '}
                        {campaign.strategy.positioning}
                      </p>
                    )}
                    {(campaign.strategy?.coreAngle || campaign.angle) && (
                      <p>
                        <span className="font-medium text-zinc-700">Angle / Hook:</span>{' '}
                        {campaign.strategy?.coreAngle ?? campaign.angle}
                      </p>
                    )}
                    {campaign.strategy?.offerMessage && (
                      <p>
                        <span className="font-medium text-zinc-700">Offer / CTA Message:</span>{' '}
                        {campaign.strategy.offerMessage}
                      </p>
                    )}
                    {campaign.strategy?.hypothesis && (
                      <p className="text-[11px] text-zinc-500 italic bg-zinc-50 p-2 rounded border border-zinc-150">
                        <span className="font-medium not-italic text-zinc-700">Hypothesis:</span>{' '}
                        {campaign.strategy.hypothesis}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-zinc-400 italic">No strategic angle or offer specified yet.</p>
                )}
              </div>
            </div>
          </div>

          {/* Section 2: Performance Targets & KPIs */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <Sliders className="size-4 text-emerald-600" />
                Performance Targets & KPIs
              </h2>
              <Button
                variant="ghost"
                onClick={() => setShowTargetsModal(true)}
                className="text-xs text-blue-600 hover:text-blue-700 h-7 px-2 py-0.5"
              >
                Configure Targets
              </Button>
            </div>

            {campaign.targets.length === 0 ? (
              <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-xs text-zinc-400">
                <p>No performance targets configured for this campaign yet.</p>
                <Button
                  variant="secondary"
                  onClick={() => setShowTargetsModal(true)}
                  className="mt-3 text-xs"
                >
                  Set Primary KPI
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Primary KPI Card */}
                {campaign.primaryTarget && (
                  <div className="rounded-md border-2 border-emerald-200 bg-emerald-50/40 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-emerald-800 flex items-center gap-1.5">
                        <Star className="size-3.5 fill-emerald-600 text-emerald-600" />
                        Primary KPI
                      </span>
                      <Badge tone="success">
                        {METRIC_LABELS[campaign.primaryTarget.metricKey] ??
                          campaign.primaryTarget.metricKey}
                      </Badge>
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-2xl font-bold tracking-tight text-zinc-900">
                        {formatNumber(campaign.primaryTarget.targetValue)}
                      </span>
                      {campaign.primaryTarget.unit && (
                        <span className="text-xs font-medium text-zinc-500">
                          {campaign.primaryTarget.unit}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Supporting Metrics */}
                {campaign.supportingTargets.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-600 mb-2">Supporting Metrics</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {campaign.supportingTargets.map((t: CampaignTarget) => (
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
                {campaign.accounts.map((acc: CampaignAccountItem) => (
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
        </div>

        {/* Right Column: Research & Meta */}
        <div className="space-y-6">
          {/* Research Section */}
          <CampaignResearchSection campaign={campaign} />

          {/* Workflows Section */}
          <CampaignWorkflowsSection campaign={campaign} activeWorkflows={activeWorkflows} />

          {/* Campaign Overview Meta Card */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
              Campaign Properties
            </h3>
            <div className="space-y-3 text-xs">
              <div>
                <span className="text-zinc-400 block mb-0.5">Status</span>
                <Badge tone={statusTone(campaign.status)}>{campaign.status.toUpperCase()}</Badge>
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
                    {OBJECTIVE_LABELS[campaign.objective as CampaignObjective] ??
                      campaign.objective}
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

      {/* Edit Modal */}
      {showEditModal && (
        <CampaignFormModal
          campaign={campaign}
          brands={brands}
          productsByBrand={productsByBrand}
          allAccounts={allAccounts}
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
          metricDefinitions={metricDefinitions}
          onClose={() => setShowTargetsModal(false)}
          onSuccess={async () => {
            await router.invalidate()
          }}
        />
      )}
    </div>
  )
}
