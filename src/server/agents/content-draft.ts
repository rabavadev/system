import { z } from 'zod'
import type { CampaignContentItem } from '~/types/domain'
import { sha256Hex } from '../approval/snapshot.ts'

export const generatedContentDraftSchema = z.object({
  headline: z.string().max(300).nullable().optional(),
  body: z.string().min(1, 'Body cannot be empty').max(20000),
  callToAction: z.string().max(500).nullable().optional(),
  creativeDirection: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

export type GeneratedContentDraft = {
  headline: string | null
  body: string
  callToAction: string | null
  creativeDirection: string | null
  notes: string | null
}

export class CreatorDraftParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CreatorDraftParseError'
  }
}

/**
 * Computes deterministic canonical SHA-256 hash of structured draft content.
 */
export function computeDraftHash(draft: {
  headline?: string | null | undefined
  body: string
  callToAction?: string | null | undefined
  creativeDirection?: string | null | undefined
  notes?: string | null | undefined
}): string {
  const canonical = JSON.stringify({
    headline: draft.headline?.trim() || null,
    body: draft.body.trim(),
    callToAction: draft.callToAction?.trim() || null,
    creativeDirection: draft.creativeDirection?.trim() || null,
    notes: draft.notes?.trim() || null,
  })
  return sha256Hex(canonical)
}

/**
 * Provider-neutral task prompt composer for Creator drafting.
 * Synthesizes the content plan item's attributes (type, purpose, brief, theme)
 * and target platform into clear generation instructions.
 */
export function composeContentDraftTask(
  item: CampaignContentItem,
  platformName?: string | null,
): string {
  const parts: string[] = [
    'Create a draft for this planned campaign content item.',
    '',
    '## Content Item Brief',
    `- Title / Concept: ${item.title ?? 'Untitled'}`,
    `- Content Type: ${item.contentType}`,
    `- Purpose: ${item.purpose ?? 'Not specified'}`,
  ]

  if (item.theme) {
    parts.push(`- Theme / Angle: ${item.theme}`)
  }

  if (platformName) {
    parts.push(`- Target Platform: ${platformName}`)
  } else if (item.platformName) {
    parts.push(`- Target Platform: ${item.platformName}`)
  }

  if (item.accountHandle) {
    parts.push(`- Target Account: @${item.accountHandle.replace(/^@/, '')}`)
  }

  if (item.brief) {
    parts.push(`- Detailed Brief: ${item.brief}`)
  }

  if (item.plannedAt) {
    parts.push(`- Planned Target Date: ${item.plannedAt.slice(0, 10)}`)
  }

  parts.push(
    '',
    '## Instructions',
    '1. Ground your draft strictly in the provided Campaign Strategy, Target Audience, Positioning, and Brand context.',
    '2. Tailor the tone, format, and structure to the specified Content Type and Target Platform.',
    '3. Do not invent exact arbitrary character limits or technical platform algorithm claims unless specified in the context.',
    '4. Provide your response as a valid JSON object matching this structure:',
    '```json',
    '{',
    '  "headline": "Compelling headline or hook (or null if not applicable)",',
    '  "body": "Primary copy, caption, post text, thread, or script content",',
    '  "callToAction": "Clear CTA text (or null if not applicable)",',
    '  "creativeDirection": "Visual framing, scene notes, image style, or audio cues (or null if not applicable)",',
    '  "notes": "Strategic angles, hashtags, or context notes (or null if not applicable)"',
    '}',
    '```',
    'Output valid JSON only.',
  )

  return parts.join('\n')
}

/**
 * Robustly parses and strictly validates the structured draft output from the Creator agent's response.
 * Accepts pure JSON or fenced markdown JSON (```json ... ```).
 * Rejects malformed JSON, non-object shapes, missing body, invalid types, or oversized fields.
 */
export function parseContentDraftOutput(rawOutput: string): GeneratedContentDraft {
  const trimmed = (rawOutput ?? '').trim()
  if (!trimmed) {
    throw new CreatorDraftParseError('Creator output is empty')
  }

  // 1. Try finding JSON within markdown code fences
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const jsonCandidate = jsonMatch?.[1] ? jsonMatch[1].trim() : trimmed

  // 2. Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonCandidate)
  } catch {
    throw new CreatorDraftParseError('Creator output is not valid JSON')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CreatorDraftParseError('Creator output must be a JSON object')
  }

  const rawObj = parsed as Record<string, unknown>
  const candidateObj = {
    headline: rawObj['headline'] ?? null,
    body: rawObj['body'] ?? rawObj['content'],
    callToAction: rawObj['callToAction'] ?? rawObj['cta'] ?? null,
    creativeDirection: rawObj['creativeDirection'] ?? null,
    notes: rawObj['notes'] ?? null,
  }

  const result = generatedContentDraftSchema.safeParse(candidateObj)
  if (!result.success) {
    throw new CreatorDraftParseError(
      `Invalid Creator draft schema: ${result.error.issues[0]?.message ?? result.error.message}`,
    )
  }

  return {
    headline: result.data.headline?.trim() || null,
    body: result.data.body.trim(),
    callToAction: result.data.callToAction?.trim() || null,
    creativeDirection: result.data.creativeDirection?.trim() || null,
    notes: result.data.notes?.trim() || null,
  }
}
