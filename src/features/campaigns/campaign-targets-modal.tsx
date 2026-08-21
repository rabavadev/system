import { Plus, Star, Trash2 } from 'lucide-react'
import { useState, useTransition } from 'react'

import { Button } from '~/components/ui/button'
import { FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import type { CampaignDetail } from '~/server/db/campaign'
import type { CampaignMetricKey, CampaignTarget, MetricDefinition } from '~/types/domain'
import { updateCampaignTargetsFn } from './server'

interface MetricOption {
  key: string
  label: string
  defaultUnit: string
  isPercent?: boolean
}

const DEFAULT_METRIC_OPTIONS: MetricOption[] = [
  { key: 'revenue', label: 'Revenue', defaultUnit: 'USD' },
  { key: 'conversions', label: 'Conversions / Sales', defaultUnit: 'orders' },
  { key: 'orders', label: 'Orders', defaultUnit: 'orders' },
  { key: 'conversion_rate', label: 'Conversion Rate (%)', defaultUnit: '%', isPercent: true },
  { key: 'qualified_visits', label: 'Qualified Visits', defaultUnit: 'visits' },
  { key: 'clicks', label: 'Total Clicks', defaultUnit: 'clicks' },
  { key: 'outbound_clicks', label: 'Outbound Clicks', defaultUnit: 'clicks' },
  { key: 'ctr', label: 'Click-Through Rate (CTR %)', defaultUnit: '%', isPercent: true },
  { key: 'leads', label: 'Leads / Signups', defaultUnit: 'leads' },
  { key: 'saves', label: 'Saves / Bookmarks', defaultUnit: 'saves' },
  { key: 'engagements', label: 'Engagements', defaultUnit: 'actions' },
  { key: 'impressions', label: 'Impressions', defaultUnit: 'views' },
]

interface CampaignTargetsModalProps {
  campaign: CampaignDetail
  metricDefinitions?: MetricDefinition[]
  onClose: () => void
  onSuccess?: () => void
}

interface EditableTarget {
  id?: string
  tempId: string
  metricKey: CampaignMetricKey
  targetValue: string
  unit: string
  isPrimary: boolean
}

export function CampaignTargetsModal({
  campaign,
  metricDefinitions,
  onClose,
  onSuccess,
}: CampaignTargetsModalProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const metricOptions: MetricOption[] =
    metricDefinitions && metricDefinitions.length > 0
      ? metricDefinitions.map((d) => ({
          key: d.key,
          label: d.name,
          defaultUnit: d.unit ?? '',
          isPercent: d.unit === 'percent' || d.key === 'conversion_rate' || d.key === 'ctr',
        }))
      : DEFAULT_METRIC_OPTIONS

  const fallbackMetric = metricOptions[0] ?? {
    key: 'revenue',
    label: 'Revenue',
    defaultUnit: 'USD',
  }

  const [targets, setTargets] = useState<EditableTarget[]>(() => {
    if (campaign.targets && campaign.targets.length > 0) {
      return campaign.targets.map((t: CampaignTarget) => ({
        id: t.id,
        tempId: t.id || crypto.randomUUID(),
        metricKey: t.metricKey,
        targetValue: String(t.targetValue),
        unit: t.unit ?? '',
        isPrimary: t.isPrimary,
      }))
    }
    return []
  })

  const addTarget = () => {
    const existingKeys = new Set(targets.map((t) => t.metricKey))
    const nextAvailable = metricOptions.find((m) => !existingKeys.has(m.key)) ?? fallbackMetric
    const isFirst = targets.length === 0

    setTargets([
      ...targets,
      {
        tempId: crypto.randomUUID(),
        metricKey: nextAvailable.key,
        targetValue: '',
        unit: nextAvailable.defaultUnit,
        isPrimary: isFirst,
      },
    ])
  }

  const removeTarget = (index: number) => {
    const next = targets.filter((_, idx) => idx !== index)
    if (targets[index]?.isPrimary && next.length > 0 && next[0]) {
      next[0].isPrimary = true
    }
    setTargets(next)
  }

  const setPrimaryIndex = (index: number) => {
    setTargets(
      targets.map((t, idx) => ({
        ...t,
        isPrimary: idx === index,
      })),
    )
  }

  const updateMetric = (index: number, key: CampaignMetricKey) => {
    const option = metricOptions.find((m) => m.key === key)
    setTargets(
      targets.map((t, idx) => {
        if (idx === index) {
          return {
            ...t,
            metricKey: key,
            unit: option?.defaultUnit ?? t.unit,
          }
        }
        return t
      }),
    )
  }

  const updateValue = (index: number, val: string) => {
    setTargets(targets.map((t, idx) => (idx === index ? { ...t, targetValue: val } : t)))
  }

  const updateUnit = (index: number, val: string) => {
    setTargets(targets.map((t, idx) => (idx === index ? { ...t, unit: val } : t)))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (targets.length > 0) {
      const primaryCount = targets.filter((t) => t.isPrimary).length
      if (primaryCount !== 1) {
        setError('Please designate exactly one Primary KPI.')
        return
      }

      for (const t of targets) {
        const num = Number(t.targetValue)
        if (Number.isNaN(num) || num < 0) {
          setError(`Target for ${t.metricKey} must be a non-negative number.`)
          return
        }
        if (['conversion_rate', 'ctr'].includes(t.metricKey)) {
          if (num < 0 || num > 100) {
            setError(`Percentage metric ${t.metricKey} must be between 0% and 100%.`)
            return
          }
        }
      }
    }

    startTransition(async () => {
      try {
        const formattedTargets = targets.map((t, idx) => ({
          id: t.id,
          metricKey: t.metricKey,
          targetValue: Number(t.targetValue),
          unit: t.unit.trim() || null,
          isPrimary: t.isPrimary,
          orderIndex: idx,
        }))

        await updateCampaignTargetsFn({
          data: {
            workspaceId: campaign.workspaceId,
            id: campaign.id,
            targets: formattedTargets,
          },
        })

        onSuccess?.()
        onClose()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save targets.')
      }
    })
  }

  return (
    <Modal title="Configure Success Metrics & Targets" onClose={onClose}>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 max-h-[80vh] overflow-y-auto px-1 py-1"
      >
        {error && <FormError message={error} />}

        <div className="space-y-3">
          {targets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-xs text-zinc-500">
              <p className="mb-3">No targets configured for this campaign yet.</p>
              <Button variant="secondary" type="button" onClick={addTarget}>
                <Plus className="size-3.5 mr-1" />
                Add First KPI Target
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-zinc-500 px-1">
                <span>Metric & Value</span>
                <Button variant="ghost" type="button" onClick={addTarget} className="h-7 text-xs">
                  <Plus className="size-3.5 mr-1" />
                  Add Metric
                </Button>
              </div>

              <div className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
                {targets.map((t, idx) => (
                  <div
                    key={t.tempId}
                    className="p-3 flex flex-col sm:flex-row sm:items-center gap-2.5"
                  >
                    {/* Primary KPI Toggle */}
                    <button
                      type="button"
                      onClick={() => setPrimaryIndex(idx)}
                      title={t.isPrimary ? 'Primary KPI' : 'Click to set as Primary KPI'}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors shrink-0 ${
                        t.isPrimary
                          ? 'bg-amber-100 text-amber-800 border border-amber-300'
                          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 border border-transparent'
                      }`}
                    >
                      <Star
                        className={`size-3.5 ${
                          t.isPrimary ? 'fill-amber-500 text-amber-600' : 'text-zinc-400'
                        }`}
                      />
                      {t.isPrimary ? 'Primary KPI' : 'Make Primary'}
                    </button>

                    {/* Metric Selection */}
                    <div className="w-full sm:w-44 shrink-0">
                      <select
                        value={t.metricKey}
                        onChange={(e) => updateMetric(idx, e.target.value as CampaignMetricKey)}
                        className={inputClass}
                      >
                        {metricOptions.map((opt) => (
                          <option key={opt.key} value={opt.key}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Target Value & Unit */}
                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={t.targetValue}
                        onChange={(e) => updateValue(idx, e.target.value)}
                        placeholder="Target value"
                        className={inputClass}
                        required
                      />

                      <input
                        type="text"
                        value={t.unit}
                        onChange={(e) => updateUnit(idx, e.target.value)}
                        placeholder="Unit"
                        className={`${inputClass} w-20 shrink-0`}
                      />
                    </div>

                    {/* Remove Action */}
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => removeTarget(idx)}
                      className="p-1.5 text-zinc-400 hover:text-red-600"
                      title="Remove Target"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-md bg-blue-50 p-2.5 text-[11px] text-blue-800 border border-blue-100">
          <p className="font-medium mb-0.5">Note on Tracking & Data Integrity</p>
          <p className="text-blue-700">
            These targets set your strategic benchmark. Real metrics will appear once analytics
            tracking is enabled.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100">
          <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving Targets...' : 'Save Targets'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
