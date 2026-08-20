import type { CampaignContentItem } from '~/types/domain'

export interface GeneratedContentDraft {
  headline: string | null
  body: string
  callToAction: string | null
  creativeDirection: string | null
  notes: string | null
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
 * Robustly parses the structured draft output from the Creator agent's response.
 * Handles pure JSON, fenced markdown JSON (```json ... ```), or plain text fallback.
 */
export function parseContentDraftOutput(rawOutput: string): GeneratedContentDraft {
  const trimmed = (rawOutput ?? '').trim()
  if (!trimmed) {
    return {
      headline: null,
      body: '',
      callToAction: null,
      creativeDirection: null,
      notes: null,
    }
  }

  // 1. Try finding JSON within markdown code fences
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const jsonCandidate = jsonMatch?.[1] ? jsonMatch[1].trim() : trimmed

  // 2. Try parsing JSON
  try {
    const parsed = JSON.parse(jsonCandidate)
    if (parsed && typeof parsed === 'object') {
      const headline =
        typeof parsed.headline === 'string' && parsed.headline.trim().length > 0
          ? parsed.headline.trim()
          : null
      const body =
        typeof parsed.body === 'string' && parsed.body.trim().length > 0
          ? parsed.body.trim()
          : typeof parsed.content === 'string' && parsed.content.trim().length > 0
            ? parsed.content.trim()
            : trimmed
      const callToAction =
        typeof parsed.callToAction === 'string' && parsed.callToAction.trim().length > 0
          ? parsed.callToAction.trim()
          : typeof parsed.cta === 'string' && parsed.cta.trim().length > 0
            ? parsed.cta.trim()
            : null
      const creativeDirection =
        typeof parsed.creativeDirection === 'string' && parsed.creativeDirection.trim().length > 0
          ? parsed.creativeDirection.trim()
          : null
      const notes =
        typeof parsed.notes === 'string' && parsed.notes.trim().length > 0
          ? parsed.notes.trim()
          : null

      return {
        headline,
        body,
        callToAction,
        creativeDirection,
        notes,
      }
    }
  } catch {
    // Not valid JSON, proceed to text fallback
  }

  // 3. Fallback: treat the entire raw output as the body
  return {
    headline: null,
    body: trimmed,
    callToAction: null,
    creativeDirection: null,
    notes: null,
  }
}
