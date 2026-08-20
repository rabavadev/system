import { Bot, CheckCircle2, Copy, FileText, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useState, useTransition } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import type { GeneratedContentDraft } from '~/server/agents/content-draft'
import type { CampaignDetail } from '~/server/db/campaign'
import type { ContentVariantDetail, DraftProvenance } from '~/server/db/content-variant'
import type { CampaignContentItem } from '~/types/domain'
import {
  generateCampaignContentDraftFn,
  listContentVariantsFn,
  saveCampaignContentDraftFn,
} from './server'

interface CampaignDraftModalProps {
  campaign: CampaignDetail
  contentItem: CampaignContentItem
  onClose: () => void
  onSuccess?: () => Promise<void> | void
}

export function CampaignDraftModal({
  campaign,
  contentItem,
  onClose,
  onSuccess,
}: CampaignDraftModalProps) {
  const [_existingVariants, setExistingVariants] = useState<ContentVariantDetail[]>([])
  const [isLoadingVariants, setIsLoadingVariants] = useState(true)

  // Draft state (candidate or edited)
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

  const [isGenerating, startGenerating] = useTransition()
  const [isSaving, startSaving] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Load existing variants on mount
  useEffect(() => {
    let active = true
    async function load() {
      setIsLoadingVariants(true)
      try {
        const variants = await listContentVariantsFn({
          data: { contentId: contentItem.id },
        })
        if (!active) return
        setExistingVariants(variants)
        if (variants && variants.length > 0) {
          const latest = variants[0]
          if (latest) {
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
    setError(null)
    setSuccessMessage(null)
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

    setError(null)
    startSaving(async () => {
      try {
        await saveCampaignContentDraftFn({
          data: {
            campaignId: campaign.id,
            contentId: contentItem.id,
            draft: {
              headline: draft.headline?.trim() || null,
              body: draft.body.trim(),
              callToAction: draft.callToAction?.trim() || null,
              creativeDirection: draft.creativeDirection?.trim() || null,
              notes: draft.notes?.trim() || null,
            },
            provenance: provenance ?? undefined,
          },
        })

        setIsCandidate(false)
        setIsSaved(true)
        setSuccessMessage('Draft saved successfully to content variant!')
        await onSuccess?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save draft.')
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
            <div className="space-y-1">
              <p className="text-xs font-medium text-zinc-800">No draft created yet</p>
              <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                Ask the platform-neutral <strong>Creator</strong> agent to generate a draft using
                this campaign's strategy, brief, and positioning.
              </p>
            </div>
            <Button
              variant="primary"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="mt-2"
            >
              <Sparkles className="size-3.5 mr-1.5" />
              Generate Draft with Creator
            </Button>
          </div>
        ) : (
          /* Draft Form / Review State */
          <div className="space-y-3">
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
                  <span className="font-semibold text-zinc-700">Generation Provenance</span>
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
                  <span>
                    Model: <span className="font-mono">{provenance.model}</span>
                  </span>
                  <span>
                    Execution:{' '}
                    <span className="font-mono">{provenance.executionId.slice(0, 8)}...</span>
                  </span>
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
                disabled={isGenerating || isSaving}
                className="text-xs text-zinc-600 hover:text-zinc-900"
              >
                <RefreshCw className={`size-3.5 mr-1.5 ${isGenerating ? 'animate-spin' : ''}`} />
                Regenerate
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={isSaving || isGenerating}>
              {isCandidate ? 'Discard' : 'Close'}
            </Button>

            {hasDraftContent && (
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={isSaving || isGenerating || !draft.body.trim()}
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
