import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  History,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { useEffect, useState, useTransition } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import type { GeneratedContentDraft } from '~/server/agents/content-draft'
import type { GeneratedContentReview } from '~/server/agents/content-review'
import type { CampaignDetail } from '~/server/db/campaign'
import type { CriticReviewProvenance } from '~/server/db/content-review'
import type { ContentVariantDetail, DraftProvenance } from '~/server/db/content-variant'
import type {
  CampaignContentItem,
  ContentReviewDetail,
  IssueSeverity,
  PostDetail,
  ReviewIssue,
  ReviewVerdict,
} from '~/types/domain'
import {
  approveCampaignContentVariantFn,
  createPublicationIntentFn,
  generateCampaignContentDraftFn,
  generateCampaignContentReviewFn,
  generateCampaignContentRevisionFn,
  listContentReviewsFn,
  listContentVariantsFn,
  listPostsForContentFn,
  revokeCampaignContentApprovalFn,
  saveCampaignContentDraftFn,
  saveCampaignContentReviewFn,
} from './server'

interface CampaignDraftModalProps {
  campaign: CampaignDetail
  contentItem: CampaignContentItem
  onClose: () => void
  onSuccess?: () => Promise<void> | void
}

function getSeverityBadge(severity: IssueSeverity) {
  switch (severity) {
    case 'high':
      return <Badge tone="warning">High</Badge>
    case 'medium':
      return <Badge tone="warning">Medium</Badge>
    case 'low':
      return <Badge tone="neutral">Low</Badge>
    default:
      return <Badge tone="neutral">{severity}</Badge>
  }
}

function getVerdictBadge(verdict: ReviewVerdict) {
  if (verdict === 'pass') {
    return <Badge tone="success">Pass</Badge>
  }
  return <Badge tone="warning">Revise</Badge>
}

export function CampaignDraftModal({
  campaign,
  contentItem,
  onClose,
  onSuccess,
}: CampaignDraftModalProps) {
  const [activeItem, setActiveItem] = useState<CampaignContentItem>(contentItem)
  const [_existingVariants, setExistingVariants] = useState<ContentVariantDetail[]>([])
  const [savedVariantId, setSavedVariantId] = useState<string | null>(null)
  const [isLoadingVariants, setIsLoadingVariants] = useState(true)

  // Draft state (candidate or edited)
  const [candidateId, setCandidateId] = useState<string | null>(null)
  const [draft, setDraft] = useState<GeneratedContentDraft>({
    headline: '',
    body: '',
    callToAction: '',
    creativeDirection: '',
    notes: '',
  })
  const [provenance, setProvenance] = useState<DraftProvenance | null>(null)
  const [isCandidate, setIsCandidate] = useState(false)
  const [isSaved, setIsSaved] = useState(false)
  const [hasCopied, setHasCopied] = useState(false)

  // Critic Review states
  const [reviews, setReviews] = useState<ContentReviewDetail[]>([])
  const [_isLoadingReviews, setIsLoadingReviews] = useState(false)
  const [candidateReviewId, setCandidateReviewId] = useState<string | null>(null)
  const [candidateReview, setCandidateReview] = useState<GeneratedContentReview | null>(null)
  const [reviewProvenance, setReviewProvenance] = useState<CriticReviewProvenance | null>(null)
  const [isReviewCandidate, setIsReviewCandidate] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [expandedReviewId, setExpandedReviewId] = useState<string | null>(null)

  // STEP 15D: Human Editorial Approval states
  const [isApproving, startApproving] = useTransition()
  const [isRevoking, startRevoking] = useTransition()
  const [showOverrideConfirm, setShowOverrideConfirm] = useState(false)
  const [overrideNote, setOverrideNote] = useState('')

  // STEP 15E.1: Publication Intent states
  const [posts, setPosts] = useState<PostDetail[]>([])
  const [isPreparingPublication, startPreparingPublication] = useTransition()

  const [isGenerating, startGenerating] = useTransition()
  const [isRevising, startRevising] = useTransition()
  const [isSaving, startSaving] = useTransition()
  const [isReviewing, startReviewing] = useTransition()
  const [isSavingReview, startSavingReview] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Load existing variants & posts on mount
  useEffect(() => {
    let active = true
    async function load() {
      setIsLoadingVariants(true)
      try {
        const [variants, postList] = await Promise.all([
          listContentVariantsFn({
            data: { contentId: contentItem.id },
          }),
          listPostsForContentFn({
            data: { contentId: contentItem.id },
          }),
        ])
        if (!active) return
        setExistingVariants(variants)
        setPosts(postList)
        if (variants && variants.length > 0) {
          const latest = variants[0]
          if (latest) {
            setSavedVariantId(latest.id)
            setDraft({
              headline: latest.headline ?? '',
              body: latest.body ?? '',
              callToAction: latest.callToAction ?? '',
              creativeDirection: latest.creativeDirection ?? '',
              notes: latest.notes ?? '',
            })
            setProvenance(latest.provenance)
            setIsSaved(true)
            setIsCandidate(false)

            // Load reviews for this variant
            setIsLoadingReviews(true)
            try {
              const reviewList = await listContentReviewsFn({
                data: { contentVariantId: latest.id },
              })
              if (active) setReviews(reviewList)
            } finally {
              if (active) setIsLoadingReviews(false)
            }
          }
        }
      } catch {
        // ignore
      } finally {
        if (active) setIsLoadingVariants(false)
      }
    }
    load()
    return () => {
      active = false
    }
  }, [contentItem.id])

  const handleGenerate = () => {
    if (!contentItem.targetAccountId) {
      setError('Choose an account for this content plan item before generating a platform draft.')
      return
    }

    setError(null)
    setSuccessMessage(null)
    setCandidateReviewId(null)
    setCandidateReview(null)
    setIsReviewCandidate(false)
    startGenerating(async () => {
      try {
        const result = await generateCampaignContentDraftFn({
          data: {
            campaignId: campaign.id,
            contentId: contentItem.id,
          },
        })

        if (!result.ok) {
          setError(result.message || 'Failed to generate draft.')
          return
        }

        setCandidateId(result.candidateId)
        setDraft({
          headline: result.draft.headline ?? '',
          body: result.draft.body ?? '',
          callToAction: result.draft.callToAction ?? '',
          creativeDirection: result.draft.creativeDirection ?? '',
          notes: result.draft.notes ?? '',
        })
        setProvenance(result.provenance)
        setIsCandidate(true)
        setIsSaved(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Draft generation failed.')
      }
    })
  }

  const handleSave = () => {
    if (!draft.body.trim()) {
      setError('Draft body content cannot be empty.')
      return
    }

    if (!candidateId) {
      setError('A generation candidate is required to save a draft.')
      return
    }

    setError(null)
    startSaving(async () => {
      try {
        const saved = await saveCampaignContentDraftFn({
          data: {
            campaignId: campaign.id,
            contentId: contentItem.id,
            candidateId,
            draft: {
              headline: draft.headline?.trim() || null,
              body: draft.body.trim(),
              callToAction: draft.callToAction?.trim() || null,
              creativeDirection: draft.creativeDirection?.trim() || null,
              notes: draft.notes?.trim() || null,
            },
          },
        })

        setSavedVariantId(saved.variant.id)
        setProvenance(saved.variant.provenance)
        setIsCandidate(false)
        setIsSaved(true)
        setSuccessMessage('Draft saved successfully to content variant!')
        await onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save draft.')
      }
    })
  }

  const handleReviewDraft = () => {
    if (!savedVariantId) {
      setError('Please save the draft variant before requesting a Critic review.')
      return
    }

    setError(null)
    setSuccessMessage(null)
    startReviewing(async () => {
      try {
        const result = await generateCampaignContentReviewFn({
          data: {
            campaignId: campaign.id,
            contentId: contentItem.id,
            contentVariantId: savedVariantId,
          },
        })

        if (!result.ok) {
          setError(result.message || 'Critic review failed.')
          return
        }

        setCandidateReviewId(result.candidateId)
        setCandidateReview(result.review)
        setReviewProvenance(result.provenance)
        setIsReviewCandidate(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Critic review failed.')
      }
    })
  }

  const handleSaveReview = () => {
    if (!candidateReviewId || !savedVariantId) return

    setError(null)
    startSavingReview(async () => {
      try {
        const savedReview = await saveCampaignContentReviewFn({
          data: {
            campaignId: campaign.id,
            contentId: contentItem.id,
            contentVariantId: savedVariantId,
            candidateId: candidateReviewId,
          },
        })

        setReviews((prev) => [savedReview, ...prev.filter((r) => r.id !== savedReview.id)])
        setIsReviewCandidate(false)
        setCandidateReview(null)
        setCandidateReviewId(null)
        setSuccessMessage(
          `Editorial review (${savedReview.verdict.toUpperCase()}) saved to history!`,
        )
        await onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save editorial review.')
      }
    })
  }

  const handleReviseDraft = (sourceReviewId: string) => {
    if (!savedVariantId) {
      setError('A saved variant is required to generate a revision.')
      return
    }

    setError(null)
    setSuccessMessage(null)
    startRevising(async () => {
      try {
        const result = await generateCampaignContentRevisionFn({
          data: {
            campaignId: campaign.id,
            contentId: contentItem.id,
            sourceVariantId: savedVariantId,
            sourceReviewId,
          },
        })

        if (!result.ok) {
          setError(result.message || 'Revision generation failed.')
          return
        }

        setCandidateId(result.candidateId)
        setDraft(result.draft)
        setProvenance(result.provenance)
        setIsCandidate(true)
        setIsSaved(false)
        setSuccessMessage('Creator generated a new revision candidate addressing Critic feedback!')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Revision generation failed.')
      }
    })
  }

  const handleCopyBody = () => {
    if (!draft.body) return
    navigator.clipboard.writeText(draft.body)
    setHasCopied(true)
    setTimeout(() => setHasCopied(false), 2000)
  }

  const hasDraftContent = draft.body.trim().length > 0 || (draft.headline ?? '').trim().length > 0
  const latestSavedReview = reviews.length > 0 ? reviews[0] : null
  const isApproved =
    Boolean(savedVariantId) &&
    activeItem.selectedVariantId === savedVariantId &&
    activeItem.status === 'ready'

  const handleApproveVariant = (override = false) => {
    if (!savedVariantId) {
      setError('A saved draft variant is required for approval.')
      return
    }

    if (latestSavedReview?.verdict === 'revise' && !override && !showOverrideConfirm) {
      setShowOverrideConfirm(true)
      return
    }

    setError(null)
    setSuccessMessage(null)
    startApproving(async () => {
      try {
        const isOverride =
          latestSavedReview?.verdict === 'revise' && (override || showOverrideConfirm)
        const result = await approveCampaignContentVariantFn({
          data: {
            campaignId: campaign.id,
            contentId: activeItem.id,
            contentVariantId: savedVariantId,
            note: overrideNote.trim() || null,
            overrideCritic: isOverride ? true : undefined,
          },
        })

        setActiveItem(result.contentItem)
        setShowOverrideConfirm(false)
        setOverrideNote('')
        setSuccessMessage('Variant approved! Content is now Ready for publishing.')
        try {
          const updatedPosts = await listPostsForContentFn({
            data: { contentId: activeItem.id },
          })
          setPosts(updatedPosts)
        } catch {
          // ignore
        }
        await onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to approve variant.')
      }
    })
  }

  const handleRevokeApproval = () => {
    setError(null)
    setSuccessMessage(null)
    startRevoking(async () => {
      try {
        const result = await revokeCampaignContentApprovalFn({
          data: {
            campaignId: campaign.id,
            contentId: activeItem.id,
            note: 'Revoked by user',
          },
        })

        setActiveItem(result)
        setSuccessMessage('Approval revoked. Content status returned to Draft.')
        try {
          const updatedPosts = await listPostsForContentFn({
            data: { contentId: activeItem.id },
          })
          setPosts(updatedPosts)
        } catch {
          // ignore
        }
        await onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to revoke approval.')
      }
    })
  }

  const handlePreparePublication = () => {
    if (!savedVariantId) {
      setError('A saved variant is required to prepare publication.')
      return
    }
    const targetAccountId = contentItem.targetAccountId
    if (!targetAccountId) {
      setError('A target account is required to prepare publication.')
      return
    }

    setError(null)
    setSuccessMessage(null)
    startPreparingPublication(async () => {
      try {
        const newPost = await createPublicationIntentFn({
          data: {
            contentId: activeItem.id,
            contentVariantId: savedVariantId,
            accountId: targetAccountId,
          },
        })

        setPosts((prev) => [newPost, ...prev.filter((p) => p.id !== newPost.id)])
        setSuccessMessage('Publication intent prepared! Post record created for dispatch.')
        await onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to prepare publication.')
      }
    })
  }

  return (
    <Modal
      title={isSaved && !isCandidate ? 'Campaign Content Draft' : 'Generate Content Draft'}
      onClose={onClose}
    >
      <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
        {/* Brief Context Card */}
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-800">{contentItem.title}</span>
              <Badge tone="neutral">{contentItem.contentType}</Badge>
              {contentItem.purpose && <Badge tone="neutral">{contentItem.purpose}</Badge>}
            </div>
            {contentItem.platformName && (
              <span className="text-xs font-medium text-zinc-600">
                Target: {contentItem.platformName}
                {contentItem.accountHandle
                  ? ` (@${contentItem.accountHandle.replace(/^@/, '')})`
                  : ''}
              </span>
            )}
          </div>

          {contentItem.theme && (
            <p className="text-xs text-zinc-600">
              <strong className="font-medium text-zinc-700">Theme:</strong> {contentItem.theme}
            </p>
          )}

          {contentItem.brief && (
            <p className="text-xs text-zinc-600 whitespace-pre-wrap bg-white rounded p-2 border border-zinc-100">
              {contentItem.brief}
            </p>
          )}
        </div>

        {/* Error Alert */}
        {error && <FormError message={error} />}

        {/* Success Alert */}
        {successMessage && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
            <CheckCircle2 className="size-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Generation In-Progress State */}
        {isGenerating ? (
          <div className="py-10 text-center space-y-3">
            <Loader2 className="size-8 animate-spin text-indigo-600 mx-auto" />
            <p className="text-xs font-medium text-zinc-800">
              Creator Agent is reviewing campaign strategy and crafting draft...
            </p>
            <p className="text-[11px] text-zinc-400 max-w-sm mx-auto">
              Injecting target audience, positioning, core angle, and campaign context into
              generation.
            </p>
          </div>
        ) : isLoadingVariants ? (
          <div className="py-8 text-center text-xs text-zinc-400">Loading draft details...</div>
        ) : !hasDraftContent ? (
          /* Empty / Initial State */
          <div className="py-8 text-center space-y-3 border-2 border-dashed border-zinc-200 rounded-xl bg-zinc-50/30">
            <Bot className="size-8 text-zinc-400 mx-auto" />
            {!contentItem.targetAccountId ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-amber-800">Target account required</p>
                <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                  Please assign a target account to this content plan item before generating a
                  platform-specific draft with Creator.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs font-medium text-zinc-800">No draft created yet</p>
                <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                  Ask the platform-neutral <strong>Creator</strong> agent to generate a draft using
                  this campaign's strategy, brief, and positioning.
                </p>
              </div>
            )}
            <Button
              variant="primary"
              onClick={handleGenerate}
              disabled={isGenerating || !contentItem.targetAccountId}
              className="mt-2"
            >
              <Sparkles className="size-3.5 mr-1.5" />
              Generate Draft with Creator
            </Button>
          </div>
        ) : (
          /* Draft Form / Review State */
          <div className="space-y-4">
            {isCandidate && (
              <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-800">
                <div className="flex items-center gap-2">
                  <Sparkles className="size-3.5 text-amber-600 shrink-0" />
                  <span>
                    <strong>Candidate Draft:</strong> Review and edit before saving.
                  </span>
                </div>
                <Badge tone="warning">Unsaved</Badge>
              </div>
            )}

            {/* Headline / Hook */}
            <Field label="Headline / Hook (Optional)">
              <input
                type="text"
                value={draft.headline ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, headline: e.target.value }))}
                placeholder="Catchy headline, hook, or subject line..."
                className={inputClass}
              />
            </Field>

            {/* Main Body */}
            <Field label="Draft Copy / Body / Script *">
              <div className="relative">
                <textarea
                  rows={5}
                  value={draft.body}
                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                  placeholder="Primary copy, caption, post body, or script..."
                  className={`${inputClass} font-mono leading-relaxed`}
                />
                <button
                  type="button"
                  onClick={handleCopyBody}
                  title="Copy text"
                  className="absolute top-2 right-2 rounded p-1 text-zinc-400 hover:text-zinc-700 bg-white/80 border border-zinc-200 shadow-xs text-[11px] flex items-center gap-1"
                >
                  <Copy className="size-3" />
                  {hasCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </Field>

            {/* CTA */}
            <Field label="Call to Action (CTA)">
              <input
                type="text"
                value={draft.callToAction ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, callToAction: e.target.value }))}
                placeholder="e.g., Click the link in bio to get started..."
                className={inputClass}
              />
            </Field>

            {/* Creative Direction */}
            <Field label="Creative Direction / Visual Notes">
              <textarea
                rows={2}
                value={draft.creativeDirection ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, creativeDirection: e.target.value }))}
                placeholder="Visual cues, scene framing, camera angle, or image concept..."
                className={inputClass}
              />
            </Field>

            {/* Strategic Notes */}
            <Field label="Notes / Hashtags / Angles">
              <input
                type="text"
                value={draft.notes ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                placeholder="Strategic notes, relevant hashtags, or tags..."
                className={inputClass}
              />
            </Field>

            {/* Provenance Box */}
            {provenance && (
              <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2.5 text-[11px] text-zinc-500 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-700 flex items-center gap-1.5">
                    {provenance.sourceVariantId ? 'Revision Lineage' : 'Generation Provenance'}
                    {provenance.sourceVariantId && (
                      <span className="font-normal text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded text-[10px]">
                        Revision based on Critic feedback
                      </span>
                    )}
                    {provenance.humanEdited && (
                      <span className="font-normal text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded text-[10px]">
                        Edited before save
                      </span>
                    )}
                  </span>
                  <span className="font-mono">
                    {provenance.createdAt.slice(0, 19).replace('T', ' ')}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-zinc-600">
                  <span>
                    Agent:{' '}
                    <strong>
                      {provenance.agentName} (v{provenance.versionNumber})
                    </strong>
                  </span>
                  {provenance.model && (
                    <span>
                      Model: <span className="font-mono">{provenance.model}</span>
                    </span>
                  )}
                  <span>
                    Execution:{' '}
                    <span className="font-mono">{provenance.executionId.slice(0, 8)}...</span>
                  </span>
                </div>
              </div>
            )}

            {/* STEP 15B: Critic Editorial Review Section */}
            {isSaved && !isCandidate && savedVariantId && (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/30 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="size-4 text-indigo-700" />
                    <span className="text-xs font-semibold text-zinc-900">
                      Critic Editorial Review
                    </span>
                    {latestSavedReview && getVerdictBadge(latestSavedReview.verdict)}
                  </div>

                  <div className="flex items-center gap-2">
                    {reviews.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowHistory((h) => !h)}
                        className="text-xs font-medium text-indigo-700 hover:text-indigo-900 flex items-center gap-1"
                      >
                        <History className="size-3.5" />
                        History ({reviews.length})
                        {showHistory ? (
                          <ChevronDown className="size-3" />
                        ) : (
                          <ChevronRight className="size-3" />
                        )}
                      </button>
                    )}

                    <Button
                      variant="secondary"
                      onClick={handleReviewDraft}
                      disabled={isReviewing || isGenerating || isSavingReview}
                      className="h-7 px-2.5 text-xs text-indigo-700 bg-white hover:bg-indigo-50 border-indigo-200"
                    >
                      {isReviewing ? (
                        <>
                          <Loader2 className="size-3 mr-1 animate-spin" />
                          Reviewing...
                        </>
                      ) : (
                        <>
                          <Bot className="size-3 mr-1 text-indigo-600" />
                          {reviews.length > 0 ? 'Review Again' : 'Review Draft with Critic'}
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Review In-Progress */}
                {isReviewing && (
                  <div className="py-6 text-center space-y-2 bg-white rounded-lg border border-indigo-100">
                    <Loader2 className="size-6 animate-spin text-indigo-600 mx-auto" />
                    <p className="text-xs font-medium text-zinc-800">
                      Critic Agent is analyzing copy, audience fit, positioning, and claims...
                    </p>
                    <p className="text-[11px] text-zinc-400">
                      Evaluating against Campaign objective, primary angle, and known platform
                      guidelines.
                    </p>
                  </div>
                )}

                {/* Candidate Review Preview */}
                {isReviewCandidate && candidateReview && (
                  <div className="rounded-lg border border-amber-300 bg-white p-3.5 space-y-3 shadow-xs">
                    <div className="flex items-center justify-between border-b border-zinc-100 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-zinc-900">
                          Review Candidate
                        </span>
                        {getVerdictBadge(candidateReview.verdict)}
                      </div>
                      <Badge tone="warning">Unsaved Review</Badge>
                    </div>

                    <p className="text-xs text-zinc-700 font-medium leading-relaxed">
                      {candidateReview.summary}
                    </p>

                    {/* Strengths */}
                    {candidateReview.strengths.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-[11px] font-semibold text-emerald-800 uppercase tracking-wider">
                          Strengths
                        </span>
                        <ul className="text-xs text-zinc-600 space-y-1 list-disc list-inside">
                          {candidateReview.strengths.map((s: string) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Issues */}
                    {candidateReview.issues.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-[11px] font-semibold text-amber-800 uppercase tracking-wider">
                          Identified Issues
                        </span>
                        <div className="space-y-1.5">
                          {candidateReview.issues.map((iss: ReviewIssue) => (
                            <div
                              key={`${iss.category}-${iss.message}`}
                              className="rounded border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-700 flex items-start gap-2"
                            >
                              <div className="mt-0.5 shrink-0">
                                {getSeverityBadge(iss.severity)}
                              </div>
                              <div className="min-w-0 flex-1">
                                <span className="font-semibold text-zinc-800 capitalize">
                                  [{iss.category.replace(/_/g, ' ')}]:{' '}
                                </span>
                                <span>{iss.message}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recommended Changes */}
                    {candidateReview.recommendedChanges.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-[11px] font-semibold text-indigo-800 uppercase tracking-wider">
                          Recommended Changes
                        </span>
                        <ul className="text-xs text-zinc-600 space-y-1 list-disc list-inside">
                          {candidateReview.recommendedChanges.map((rec: string) => (
                            <li key={rec}>{rec}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Critic Provenance */}
                    {reviewProvenance && (
                      <div className="pt-2 border-t border-zinc-100 flex items-center justify-between text-[11px] text-zinc-400">
                        <span>
                          Critic v{reviewProvenance.versionNumber} ({reviewProvenance.model})
                        </span>
                        <span className="font-mono">
                          {reviewProvenance.executionId.slice(0, 8)}...
                        </span>
                      </div>
                    )}

                    {/* Candidate Review Actions */}
                    <div className="pt-2 flex items-center justify-end gap-2 border-t border-zinc-100">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setIsReviewCandidate(false)
                          setCandidateReview(null)
                        }}
                        disabled={isSavingReview}
                        className="text-xs"
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={handleReviewDraft}
                        disabled={isReviewing || isSavingReview}
                        className="text-xs"
                      >
                        <RefreshCw className="size-3 mr-1" />
                        Run Again
                      </Button>
                      <Button
                        variant="primary"
                        onClick={handleSaveReview}
                        disabled={isSavingReview}
                        className="text-xs"
                      >
                        {isSavingReview ? (
                          <>
                            <Loader2 className="size-3 mr-1 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="size-3 mr-1" />
                            Save Review
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Latest Saved Review Summary if not in candidate mode and no history expanded */}
                {!isReviewCandidate && !showHistory && latestSavedReview && (
                  <div className="rounded-lg border border-zinc-200 bg-white p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-800">
                        Latest Review Summary
                      </span>
                      <span className="text-[11px] text-zinc-400 font-mono">
                        {latestSavedReview.createdAt.slice(0, 19).replace('T', ' ')}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-600">{latestSavedReview.summary}</p>
                    {latestSavedReview.issues.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {latestSavedReview.issues.slice(0, 3).map((iss: ReviewIssue) => (
                          <span
                            key={`${iss.category}-${iss.message}`}
                            className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700"
                          >
                            <AlertTriangle className="size-2.5 text-amber-600" />
                            {iss.category}: {iss.message.slice(0, 40)}...
                          </span>
                        ))}
                      </div>
                    )}
                    {latestSavedReview.verdict === 'revise' && (
                      <div className="pt-2 border-t border-zinc-100 flex justify-end">
                        <Button
                          variant="secondary"
                          onClick={() => handleReviseDraft(latestSavedReview.id)}
                          disabled={
                            isRevising || isGenerating || isSaving || isReviewing || isSavingReview
                          }
                          className="h-7 px-2.5 text-xs text-amber-800 bg-amber-50 hover:bg-amber-100 border-amber-200"
                        >
                          {isRevising ? (
                            <>
                              <Loader2 className="size-3 mr-1 animate-spin" />
                              Revising with Creator...
                            </>
                          ) : (
                            <>
                              <Sparkles className="size-3 mr-1 text-amber-600" />
                              Revise with Creator
                            </>
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {/* Review History Accordion */}
                {showHistory && (
                  <div className="space-y-2 pt-1">
                    <span className="text-[11px] font-semibold text-zinc-700 uppercase tracking-wider">
                      Saved Review History
                    </span>
                    <div className="space-y-2">
                      {reviews.map((rev: ContentReviewDetail) => {
                        const isExpanded = expandedReviewId === rev.id
                        return (
                          <div
                            key={rev.id}
                            className="rounded-lg border border-zinc-200 bg-white overflow-hidden text-xs"
                          >
                            <button
                              type="button"
                              onClick={() => setExpandedReviewId(isExpanded ? null : rev.id)}
                              className="w-full p-2.5 flex items-center justify-between hover:bg-zinc-50 transition-colors text-left"
                            >
                              <div className="flex items-center gap-2">
                                {getVerdictBadge(rev.verdict)}
                                <span className="font-medium text-zinc-800 truncate max-w-xs">
                                  {rev.summary}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 text-zinc-400 shrink-0">
                                <span>v{rev.criticAgentVersionNumber}</span>
                                <span>{rev.createdAt.slice(0, 10)}</span>
                                {isExpanded ? (
                                  <ChevronDown className="size-3.5" />
                                ) : (
                                  <ChevronRight className="size-3.5" />
                                )}
                              </div>
                            </button>

                            {isExpanded && (
                              <div className="p-3 border-t border-zinc-100 bg-zinc-50/50 space-y-2">
                                {rev.strengths.length > 0 && (
                                  <div>
                                    <strong className="text-zinc-700 block mb-0.5">
                                      Strengths:
                                    </strong>
                                    <ul className="list-disc list-inside text-zinc-600 space-y-0.5">
                                      {rev.strengths.map((s: string) => (
                                        <li key={s}>{s}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {rev.issues.length > 0 && (
                                  <div>
                                    <strong className="text-zinc-700 block mb-0.5">Issues:</strong>
                                    <div className="space-y-1">
                                      {rev.issues.map((iss: ReviewIssue) => (
                                        <div
                                          key={`${iss.category}-${iss.message}`}
                                          className="flex items-center gap-1.5 text-zinc-600"
                                        >
                                          {getSeverityBadge(iss.severity)}
                                          <span>
                                            <strong>[{iss.category}]:</strong> {iss.message}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {rev.recommendedChanges.length > 0 && (
                                  <div>
                                    <strong className="text-zinc-700 block mb-0.5">
                                      Recommended Changes:
                                    </strong>
                                    <ul className="list-disc list-inside text-zinc-600 space-y-0.5">
                                      {rev.recommendedChanges.map((rec: string) => (
                                        <li key={rec}>{rec}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {rev.verdict === 'revise' && (
                                  <div className="pt-2 border-t border-zinc-200/60 flex justify-end">
                                    <Button
                                      variant="secondary"
                                      onClick={() => handleReviseDraft(rev.id)}
                                      disabled={
                                        isRevising ||
                                        isGenerating ||
                                        isSaving ||
                                        isReviewing ||
                                        isSavingReview
                                      }
                                      className="h-6 px-2 text-[11px] text-amber-800 bg-amber-50 hover:bg-amber-100 border-amber-200"
                                    >
                                      {isRevising ? (
                                        <>
                                          <Loader2 className="size-2.5 mr-1 animate-spin" />
                                          Revising...
                                        </>
                                      ) : (
                                        <>
                                          <Sparkles className="size-2.5 mr-1 text-amber-600" />
                                          Revise with Creator from this review
                                        </>
                                      )}
                                    </Button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* STEP 15D: Human Editorial Approval & Publish Readiness */}
            {isSaved && !isCandidate && savedVariantId && (
              <div
                className={`rounded-xl border p-4 space-y-3 transition-colors ${
                  isApproved ? 'border-emerald-200 bg-emerald-50/30' : 'border-zinc-200 bg-white'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {isApproved ? (
                      <CheckCircle2 className="size-4 text-emerald-600" />
                    ) : (
                      <FileText className="size-4 text-zinc-500" />
                    )}
                    <span className="text-xs font-semibold text-zinc-900">
                      Editorial Approval & Publish Readiness
                    </span>
                    {isApproved ? (
                      <Badge tone="success">Ready for Publishing</Badge>
                    ) : (
                      <Badge tone="neutral">Draft (Not Ready)</Badge>
                    )}
                  </div>
                </div>

                <p className="text-xs text-zinc-600">
                  {isApproved
                    ? 'This exact variant is approved as the publication candidate. No external publishing occurs until an explicit publication step is triggered.'
                    : latestSavedReview?.verdict === 'revise'
                      ? 'Critic recommends revisions before publishing. You can revise with Creator, or explicitly approve this variant anyway.'
                      : latestSavedReview?.verdict === 'pass'
                        ? 'Critic review passed. Approve this exact variant to mark content Ready for publishing.'
                        : 'Review is optional. You may approve this exact draft variant directly to mark content Ready for publishing.'}
                </p>

                {/* Override confirmation box if Critic recommended revision */}
                {showOverrideConfirm && !isApproved && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2 text-xs">
                    <div className="flex items-center gap-1.5 font-medium text-amber-800">
                      <AlertTriangle className="size-3.5 text-amber-600" />
                      <span>Critic Recommended Revisions</span>
                    </div>
                    <p className="text-amber-700">
                      You are approving this draft despite Critic issues. You can provide an
                      optional note for the audit record.
                    </p>
                    <input
                      type="text"
                      value={overrideNote}
                      onChange={(e) => setOverrideNote(e.target.value)}
                      placeholder="Optional override reason / justification..."
                      className={`${inputClass} bg-white`}
                    />
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setShowOverrideConfirm(false)
                          setOverrideNote('')
                        }}
                        className="text-xs"
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => handleApproveVariant(true)}
                        disabled={isApproving}
                        className="text-xs bg-amber-700 hover:bg-amber-800 text-white"
                      >
                        {isApproving ? (
                          <>
                            <Loader2 className="size-3 mr-1 animate-spin" />
                            Approving...
                          </>
                        ) : (
                          <>
                            <Check className="size-3 mr-1" />
                            Confirm & Approve Anyway
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Main Approval Action Bar */}
                <div className="flex items-center justify-between pt-1 border-t border-zinc-100">
                  <span className="text-[11px] text-zinc-400">
                    {isApproved
                      ? 'Approved publication candidate'
                      : 'Human approval is authoritative'}
                  </span>

                  <div className="flex items-center gap-2">
                    {isApproved ? (
                      <Button
                        variant="secondary"
                        onClick={handleRevokeApproval}
                        disabled={isRevoking || isApproving}
                        className="h-7 px-2.5 text-xs text-zinc-700 bg-white hover:bg-zinc-50 border-zinc-200"
                      >
                        {isRevoking ? (
                          <>
                            <Loader2 className="size-3 mr-1 animate-spin" />
                            Revoking...
                          </>
                        ) : (
                          <>
                            <Undo2 className="size-3 mr-1 text-zinc-500" />
                            Mark Not Ready
                          </>
                        )}
                      </Button>
                    ) : (
                      !showOverrideConfirm && (
                        <Button
                          variant="primary"
                          onClick={() => handleApproveVariant(false)}
                          disabled={
                            isApproving ||
                            isRevoking ||
                            isGenerating ||
                            isRevising ||
                            isSaving ||
                            isReviewing ||
                            isSavingReview
                          }
                          className="h-7 px-3 text-xs bg-emerald-700 hover:bg-emerald-800 text-white"
                        >
                          {isApproving ? (
                            <>
                              <Loader2 className="size-3 mr-1 animate-spin" />
                              Approving...
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="size-3.5 mr-1" />
                              Approve for Publishing (Mark Ready)
                            </>
                          )}
                        </Button>
                      )
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 15E.1: Publication Foundation & Dispatch Readiness */}
            {isSaved && !isCandidate && savedVariantId && isApproved && (
              <div className="rounded-xl border border-sky-200 bg-sky-50/30 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Send className="size-4 text-sky-600" />
                    <span className="text-xs font-semibold text-zinc-900">
                      Publication Dispatch Readiness
                    </span>
                    {posts.some(
                      (p) => p.contentVariantId === savedVariantId && p.isCurrentlyEligible,
                    ) ? (
                      <Badge tone="success">
                        {posts.find(
                          (p) => p.contentVariantId === savedVariantId && p.isCurrentlyEligible,
                        )?.dispatchStatus === 'scheduled'
                          ? 'Scheduled internally'
                          : 'Prepared for Dispatch'}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">Ready to Prepare</Badge>
                    )}
                  </div>
                </div>

                <p className="text-xs text-zinc-600">
                  {posts.some((p) => p.contentVariantId === savedVariantId && p.isCurrentlyEligible)
                    ? 'A server-authoritative publication intent record exists for this approved variant. Internal foundation active; zero external network calls are made until external dispatch is triggered.'
                    : 'This approved variant is ready to be prepared for publication. Preparing creates an internal Post record linked to the target account.'}
                </p>

                {/* Display existing publication intents if any */}
                {posts.filter((p) => p.contentVariantId === savedVariantId).length > 0 && (
                  <div className="rounded-lg border border-sky-100 bg-white p-3 space-y-2 text-xs">
                    <span className="font-medium text-zinc-800">Prepared Publication Intents:</span>
                    <div className="space-y-1.5">
                      {posts
                        .filter((p) => p.contentVariantId === savedVariantId)
                        .map((post) => {
                          const getDispatchBadge = () => {
                            switch (post.dispatchStatus) {
                              case 'prepared':
                                return <Badge tone="success">Prepared</Badge>
                              case 'scheduled':
                                return <Badge tone="success">Scheduled internally</Badge>
                              case 'stale':
                                return <Badge tone="warning">No longer Ready</Badge>
                              case 'needs_reprepare':
                                return <Badge tone="warning">Needs Re-prepare</Badge>
                              case 'published':
                                return <Badge tone="success">Published</Badge>
                              case 'publishing':
                                return <Badge tone="neutral">Publishing</Badge>
                              case 'failed':
                                return <Badge tone="warning">Failed</Badge>
                              case 'removed':
                                return <Badge tone="muted">Removed</Badge>
                              default:
                                return <Badge tone="neutral">{post.status}</Badge>
                            }
                          }

                          return (
                            <div
                              key={post.id}
                              className="flex items-center justify-between rounded bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-700"
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-zinc-800">
                                  {post.platformName ?? 'Platform'}
                                </span>
                                {post.accountHandle && (
                                  <span className="text-zinc-500">
                                    @{post.accountHandle.replace(/^@/, '')}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {getDispatchBadge()}
                                <span className="text-[11px] text-zinc-400">
                                  {new Date(post.createdAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                              </div>
                            </div>
                          )
                        })}
                    </div>
                  </div>
                )}

                {/* Action button */}
                <div className="flex items-center justify-between pt-1 border-t border-sky-100">
                  <span className="text-[11px] text-zinc-400">
                    Target: {contentItem.platformName ?? 'Platform'}{' '}
                    {contentItem.accountHandle
                      ? `(@${contentItem.accountHandle.replace(/^@/, '')})`
                      : ''}
                  </span>

                  {!posts.some(
                    (p) => p.contentVariantId === savedVariantId && p.isCurrentlyEligible,
                  ) && (
                    <Button
                      variant="primary"
                      onClick={handlePreparePublication}
                      disabled={isPreparingPublication || isApproving || isRevoking}
                      className="h-7 px-3 text-xs bg-sky-700 hover:bg-sky-800 text-white"
                    >
                      {isPreparingPublication ? (
                        <>
                          <Loader2 className="size-3 mr-1 animate-spin" />
                          Preparing...
                        </>
                      ) : (
                        <>
                          <Send className="size-3 mr-1" />
                          Prepare for Publication
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer actions */}
        <div className="border-t border-zinc-100 pt-3 flex items-center justify-between gap-2">
          <div>
            {hasDraftContent && (
              <Button
                variant="ghost"
                onClick={handleGenerate}
                disabled={isGenerating || isRevising || isSaving || isReviewing || isSavingReview}
                className="text-xs text-zinc-600 hover:text-zinc-900"
              >
                <RefreshCw className={`size-3.5 mr-1.5 ${isGenerating ? 'animate-spin' : ''}`} />
                Regenerate Draft
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={onClose}
              disabled={isSaving || isGenerating || isRevising || isSavingReview}
            >
              {isCandidate ? 'Discard' : 'Close'}
            </Button>

            {hasDraftContent && (
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={
                  isSaving || isGenerating || isRevising || isSavingReview || !draft.body.trim()
                }
              >
                {isSaving ? (
                  <>
                    <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <FileText className="size-3.5 mr-1.5" />
                    Save Draft
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
