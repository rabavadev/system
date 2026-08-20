import { useState, useTransition } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import type { CampaignDetail } from '~/server/db/campaign'
import type {
  CampaignContentItem,
  ContentPurpose,
  ContentStatus,
  ContentType,
} from '~/types/domain'
import { createCampaignContentFn, updateCampaignContentFn } from './server'

const CONTENT_TYPE_OPTIONS: Array<{ value: ContentType; label: string }> = [
  { value: 'post', label: 'Post (Standard)' },
  { value: 'short_form', label: 'Short-form (Reels/Shorts/TikTok)' },
  { value: 'long_form', label: 'Long-form (Article/Blog)' },
  { value: 'image', label: 'Image / Visual Asset' },
  { value: 'video', label: 'Video (Standard)' },
  { value: 'thread', label: 'Thread / Carousel' },
  { value: 'email', label: 'Email Newsletter' },
  { value: 'other', label: 'Other Format' },
]

const PURPOSE_OPTIONS: Array<{ value: ContentPurpose; label: string }> = [
  { value: 'awareness', label: 'Awareness (Discoverability & reach)' },
  { value: 'traffic', label: 'Qualified Traffic (Clicks & visits)' },
  { value: 'conversion', label: 'Conversion (Sales, orders, signups)' },
  { value: 'engagement', label: 'Engagement (Comments, shares, saves)' },
  { value: 'education', label: 'Education (How-to, tutorial, guides)' },
  { value: 'retention', label: 'Retention (Loyalty & repeats)' },
  { value: 'validation', label: 'Validation (Angle & message testing)' },
]

const STATUS_OPTIONS: Array<{ value: ContentStatus; label: string }> = [
  { value: 'idea', label: 'Idea (Backlog)' },
  { value: 'planned', label: 'Planned (Scheduled / in queue)' },
  { value: 'draft', label: 'Draft (In progress)' },
  { value: 'ready', label: 'Ready (Approved for publishing)' },
]

interface CampaignContentModalProps {
  campaign: CampaignDetail
  contentItem?: CampaignContentItem | null
  onClose: () => void
  onSuccess?: () => void
}

function toDateVal(iso?: string | null): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

export function CampaignContentModal({
  campaign,
  contentItem,
  onClose,
  onSuccess,
}: CampaignContentModalProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState(contentItem?.title ?? '')
  const [contentType, setContentType] = useState<ContentType>(contentItem?.contentType ?? 'post')
  const [purpose, setPurpose] = useState<ContentPurpose | ''>(contentItem?.purpose ?? '')
  const [theme, setTheme] = useState(contentItem?.theme ?? '')
  const [targetAccountId, setTargetAccountId] = useState<string>(contentItem?.targetAccountId ?? '')
  const [plannedAt, setPlannedAt] = useState(toDateVal(contentItem?.plannedAt))
  const [status, setStatus] = useState<ContentStatus>(contentItem?.status ?? 'idea')
  const [brief, setBrief] = useState(contentItem?.brief ?? '')

  const isEditing = Boolean(contentItem)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError('Title is required.')
      return
    }

    startTransition(async () => {
      try {
        const plannedIso = plannedAt ? `${plannedAt}T00:00:00.000Z` : null

        if (isEditing && contentItem) {
          await updateCampaignContentFn({
            data: {
              workspaceId: campaign.workspaceId,
              id: contentItem.id,
              title: trimmedTitle,
              contentType,
              purpose: purpose || null,
              theme: theme.trim() || null,
              targetAccountId: targetAccountId || null,
              plannedAt: plannedIso,
              status,
              brief: brief.trim() || null,
            },
          })
        } else {
          await createCampaignContentFn({
            data: {
              workspaceId: campaign.workspaceId,
              campaignId: campaign.id,
              productId: campaign.productId,
              title: trimmedTitle,
              contentType,
              purpose: purpose || null,
              theme: theme.trim() || null,
              targetAccountId: targetAccountId || null,
              plannedAt: plannedIso,
              status,
              brief: brief.trim() || null,
            },
          })
        }

        onSuccess?.()
        onClose()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save content item.')
      }
    })
  }

  return (
    <Modal title={isEditing ? 'Edit Content Plan Item' : 'Add Content Plan Item'} onClose={onClose}>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 max-h-[80vh] overflow-y-auto px-1 py-1"
      >
        {error && <FormError message={error} />}

        {/* Campaign Strategy Context Banner */}
        <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3 text-xs space-y-1.5">
          <div className="flex items-center justify-between text-indigo-900 font-medium">
            <span>Campaign Strategy Alignment</span>
            {campaign.objective && (
              <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-800 uppercase tracking-wider">
                {campaign.objective}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-zinc-600">
            {campaign.audienceDetails?.summary && (
              <div>
                <span className="font-medium text-zinc-700">Audience: </span>
                <span className="truncate">{campaign.audienceDetails.summary}</span>
              </div>
            )}
            {campaign.strategy?.coreAngle && (
              <div>
                <span className="font-medium text-zinc-700">Core Angle: </span>
                <span className="truncate">{campaign.strategy.coreAngle}</span>
              </div>
            )}
            {campaign.primaryTarget && (
              <div>
                <span className="font-medium text-zinc-700">Primary KPI: </span>
                <span>
                  {campaign.primaryTarget.metricKey} (target {campaign.primaryTarget.targetValue}
                  {campaign.primaryTarget.unit ? ` ${campaign.primaryTarget.unit}` : ''})
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Content Title */}
        <Field
          label="Content Title"
          htmlFor="content-title"
          hint="e.g. 5 Mistakes Small Sellers Make When Sourcing"
        >
          <input
            id="content-title"
            type="text"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Working title or hook..."
            className={inputClass}
          />
        </Field>

        {/* Content Type & Purpose */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Content Type" htmlFor="content-type">
            <select
              id="content-type"
              value={contentType}
              onChange={(e) => setContentType(e.target.value as ContentType)}
              className={inputClass}
            >
              {CONTENT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Strategic Purpose" htmlFor="content-purpose">
            <select
              id="content-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as ContentPurpose | '')}
              className={inputClass}
            >
              <option value="">-- Select Purpose --</option>
              {PURPOSE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* Theme / Angle */}
        <Field
          label="Theme / Creative Angle"
          htmlFor="content-theme"
          hint="e.g. Beginner pain point, Social proof, Feature comparison"
        >
          <input
            id="content-theme"
            type="text"
            maxLength={500}
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="Specific angle or theme for this piece..."
            className={inputClass}
          />
        </Field>

        {/* Target Account & Planned Date */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field
            label="Target Account & Platform"
            htmlFor="content-account"
            hint={
              campaign.accounts.length === 0
                ? 'No accounts attached to this campaign yet'
                : 'Platform derives automatically from selected account'
            }
          >
            <select
              id="content-account"
              value={targetAccountId}
              onChange={(e) => setTargetAccountId(e.target.value)}
              className={inputClass}
            >
              <option value="">-- No Account Assigned (Generic Draft) --</option>
              {campaign.accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.handle} ({acc.platformName})
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Planned Date"
            htmlFor="content-planned-date"
            hint="Planning date (not automated schedule)"
          >
            <input
              id="content-planned-date"
              type="date"
              value={plannedAt}
              onChange={(e) => setPlannedAt(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        {/* Status */}
        <Field label="Planning Status" htmlFor="content-status">
          <select
            id="content-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as ContentStatus)}
            className={inputClass}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Notes / Brief */}
        <Field label="Brief & Key Outline Notes" htmlFor="content-brief">
          <textarea
            id="content-brief"
            rows={3}
            maxLength={2000}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Key points to cover, talking points, hook notes, visual idea..."
            className={inputClass}
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100">
          <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending
              ? isEditing
                ? 'Saving Changes...'
                : 'Creating Item...'
              : isEditing
                ? 'Save Changes'
                : 'Add to Content Plan'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
