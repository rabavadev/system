import { useState, useTransition } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import type { CampaignDetail } from '~/server/db/campaign'
import type {
  AudienceAwarenessLevel,
  CampaignAudience,
  CampaignObjective,
  CampaignPriority,
} from '~/types/domain'
import { updateCampaignStrategyFn } from './server'

const OBJECTIVE_OPTIONS: Array<{ value: CampaignObjective; label: string; description: string }> = [
  { value: 'revenue', label: 'Revenue', description: 'Drive top-line and profitable growth' },
  {
    value: 'conversions',
    label: 'Sales / Conversions',
    description: 'Direct sales, checkouts, or purchase actions',
  },
  {
    value: 'traffic',
    label: 'Qualified Traffic',
    description: 'High-intent visitors arriving on destination pages',
  },
  {
    value: 'leads',
    label: 'Leads / Signups',
    description: 'Acquiring prospect contact info and registrations',
  },
  {
    value: 'awareness',
    label: 'Awareness',
    description: 'Expanding brand reach and discoverability',
  },
  {
    value: 'engagement',
    label: 'Engagement',
    description: 'Fostering saves, comments, shares, and reactions',
  },
  {
    value: 'retention',
    label: 'Retention',
    description: 'Re-engaging past customers and encouraging repeats',
  },
  {
    value: 'validation',
    label: 'Validation / Learning',
    description: 'Testing positioning, angles, or product-market signals',
  },
]

const AWARENESS_OPTIONS: Array<{ value: AudienceAwarenessLevel; label: string }> = [
  { value: 'unaware', label: 'Unaware (Do not know problem yet)' },
  { value: 'problem_aware', label: 'Problem-Aware (Feel the pain, searching for solutions)' },
  { value: 'solution_aware', label: 'Solution-Aware (Know solutions exist, comparing options)' },
  { value: 'product_aware', label: 'Product-Aware (Know your brand/product, evaluating)' },
  { value: 'most_aware', label: 'Most Aware (Ready to buy, need an offer/trigger)' },
]

interface CampaignStrategyModalProps {
  campaign: CampaignDetail
  onClose: () => void
  onSuccess?: () => void
}

export function CampaignStrategyModal({
  campaign,
  onClose,
  onSuccess,
}: CampaignStrategyModalProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [objective, setObjective] = useState<CampaignObjective | ''>(campaign.objective ?? '')
  const [priority, setPriority] = useState<CampaignPriority>(campaign.priority ?? 'normal')

  // Audience
  const [audienceSummary, setAudienceSummary] = useState(campaign.audienceDetails?.summary ?? '')
  const [problem, setProblem] = useState(campaign.audienceDetails?.problem ?? '')
  const [awarenessLevel, setAwarenessLevel] = useState<AudienceAwarenessLevel | ''>(
    campaign.audienceDetails?.awarenessLevel ?? '',
  )
  const [geography, setGeography] = useState(campaign.audienceDetails?.geography ?? '')
  const [notes, setNotes] = useState(campaign.audienceDetails?.notes ?? '')

  // Strategy
  const [positioning, setPositioning] = useState(campaign.strategy?.positioning ?? '')
  const [coreAngle, setCoreAngle] = useState(campaign.strategy?.coreAngle ?? campaign.angle ?? '')
  const [offerMessage, setOfferMessage] = useState(campaign.strategy?.offerMessage ?? '')
  const [hypothesis, setHypothesis] = useState(campaign.strategy?.hypothesis ?? '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    startTransition(async () => {
      try {
        const audiencePayload: CampaignAudience = {
          summary: audienceSummary.trim(),
          problem: problem.trim() || null,
          awarenessLevel: awarenessLevel || null,
          geography: geography.trim() || null,
          notes: notes.trim() || null,
        }

        await updateCampaignStrategyFn({
          data: {
            workspaceId: campaign.workspaceId,
            id: campaign.id,
            objective: objective || null,
            priority,
            positioning: positioning.trim() || null,
            angle: coreAngle.trim() || null,
            offerMessage: offerMessage.trim() || null,
            hypothesis: hypothesis.trim() || null,
            audience: audiencePayload.summary ? audiencePayload : null,
          },
        })

        onSuccess?.()
        onClose()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save campaign strategy.')
      }
    })
  }

  return (
    <Modal title="Edit Campaign Strategy" onClose={onClose}>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 max-h-[80vh] overflow-y-auto px-1 py-1"
      >
        {error && <FormError message={error} />}

        {/* Objective & Priority */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Primary Objective" htmlFor="campaign-objective">
            <select
              id="campaign-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value as CampaignObjective | '')}
              className={inputClass}
            >
              <option value="">-- Select Objective --</option>
              {OBJECTIVE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Campaign Priority" htmlFor="campaign-priority">
            <select
              id="campaign-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as CampaignPriority)}
              className={inputClass}
            >
              <option value="high">High Priority</option>
              <option value="normal">Normal Priority</option>
              <option value="low">Low Priority</option>
            </select>
          </Field>
        </div>

        {/* Target Audience Section */}
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3.5 space-y-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
            Target Audience
          </h3>

          <Field
            label="Audience Summary"
            htmlFor="audience-summary"
            hint="Who is this campaign speaking to?"
          >
            <input
              id="audience-summary"
              type="text"
              value={audienceSummary}
              onChange={(e) => setAudienceSummary(e.target.value)}
              placeholder="e.g. Budget-conscious college students decorating dorm rooms"
              className={inputClass}
            />
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <Field label="Awareness Level" htmlFor="audience-awareness">
              <select
                id="audience-awareness"
                value={awarenessLevel}
                onChange={(e) => setAwarenessLevel(e.target.value as AudienceAwarenessLevel | '')}
                className={inputClass}
              >
                <option value="">-- Select Awareness Level --</option>
                {AWARENESS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Target Geography" htmlFor="audience-geo">
              <input
                id="audience-geo"
                type="text"
                value={geography}
                onChange={(e) => setGeography(e.target.value)}
                placeholder="e.g. US, UK, Canada"
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Problem / Core Pain Point" htmlFor="audience-problem">
            <textarea
              id="audience-problem"
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              placeholder="What core problem or frustration does this audience experience?"
              rows={2}
              className={inputClass}
            />
          </Field>

          <Field label="Audience Notes" htmlFor="audience-notes">
            <textarea
              id="audience-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional nuances, habits, or behavioral notes..."
              rows={2}
              className={inputClass}
            />
          </Field>
        </div>

        {/* Strategic Direction Section */}
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3.5 space-y-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
            Strategic Direction
          </h3>

          <Field
            label="Positioning & Hook"
            htmlFor="strategy-positioning"
            hint="How do we position against alternatives?"
          >
            <textarea
              id="strategy-positioning"
              value={positioning}
              onChange={(e) => setPositioning(e.target.value)}
              placeholder="e.g. The fastest zero-code tool for small shop owners"
              rows={2}
              className={inputClass}
            />
          </Field>

          <Field
            label="Core Creative Angle"
            htmlFor="strategy-angle"
            hint="The conceptual angle or narrative theme"
          >
            <textarea
              id="strategy-angle"
              value={coreAngle}
              onChange={(e) => setCoreAngle(e.target.value)}
              placeholder="e.g. Stop wasting 5 hours every weekend on manual posting"
              rows={2}
              className={inputClass}
            />
          </Field>

          <Field label="Offer / Key Message" htmlFor="strategy-offer">
            <textarea
              id="strategy-offer"
              value={offerMessage}
              onChange={(e) => setOfferMessage(e.target.value)}
              placeholder="e.g. 14-day free trial + free onboarding guide"
              rows={2}
              className={inputClass}
            />
          </Field>

          <Field
            label="Key Hypothesis"
            htmlFor="strategy-hypothesis"
            hint="What are we validating with this campaign?"
          >
            <textarea
              id="strategy-hypothesis"
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
              placeholder="e.g. Highlighting time savings converts 2x better"
              rows={2}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100">
          <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving Strategy...' : 'Save Strategy'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
