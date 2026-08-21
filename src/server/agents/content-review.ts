import { z } from 'zod'
import type {
  CampaignContentItem,
  IssueSeverity,
  ReviewIssue,
  ReviewVerdict,
} from '../../types/domain.ts'
import { sha256Hex } from '../approval/snapshot.ts'
import type { ContentVariantDetail } from '../db/content-variant.ts'

export const generatedContentReviewSchema = z.object({
  verdict: z.enum(['pass', 'revise']),
  summary: z.string().min(1, 'Summary cannot be empty').max(5000),
  strengths: z.array(z.string().min(1, 'Strength item cannot be empty')),
  issues: z.array(
    z.object({
      category: z.string().min(1, 'Category cannot be empty'),
      severity: z.enum(['low', 'medium', 'high']),
      message: z.string().min(1, 'Message cannot be empty'),
    }),
  ),
  recommendedChanges: z.array(z.string().min(1, 'Recommended change cannot be empty')),
})

export type GeneratedContentReview = {
  verdict: ReviewVerdict
  summary: string
  strengths: string[]
  issues: ReviewIssue[]
  recommendedChanges: string[]
}

export class CriticReviewParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CriticReviewParseError'
  }
}

/**
 * Computes deterministic canonical SHA-256 hash of structured review content.
 */
export function computeReviewHash(review: {
  verdict: ReviewVerdict
  summary: string
  strengths?: string[] | null | undefined
  issues?: ReviewIssue[] | null | undefined
  recommendedChanges?: string[] | null | undefined
}): string {
  const canonical = JSON.stringify({
    verdict: review.verdict,
    summary: review.summary.trim(),
    strengths: Array.isArray(review.strengths) ? review.strengths.map((s) => s.trim()) : [],
    issues: Array.isArray(review.issues)
      ? review.issues.map((i) => ({
          category: i.category.trim(),
          severity: i.severity,
          message: i.message.trim(),
        }))
      : [],
    recommendedChanges: Array.isArray(review.recommendedChanges)
      ? review.recommendedChanges.map((r) => r.trim())
      : [],
  })
  return sha256Hex(canonical)
}

/**
 * Compose a focused, provider-neutral task prompt for the Critic agent
 * to review ONE saved campaign content draft variant.
 */
export function composeContentReviewTask(
  item: CampaignContentItem,
  variant: ContentVariantDetail,
  platformName?: string | null,
): string {
  const targetPlatform = platformName || item.platformName || 'General / Unassigned'
  const accountInfo = item.accountHandle ? `@${item.accountHandle.replace(/^@/, '')}` : 'None'

  const sections: string[] = [
    'You are performing a rigorous editorial review on a saved Campaign content draft.',
    '',
    '### Content Plan Context',
    `- Title: ${item.title}`,
    `- Content Type: ${item.contentType}`,
    item.purpose ? `- Purpose: ${item.purpose}` : null,
    item.theme ? `- Theme: ${item.theme}` : null,
    `- Target Platform: ${targetPlatform}`,
    item.accountHandle ? `- Target Account: ${accountInfo}` : null,
    item.plannedAt ? `- Planned Date: ${item.plannedAt.slice(0, 10)}` : null,
    item.brief ? `- Content Brief:\n${item.brief}` : null,
    '',
    '### Exact Saved Draft Variant to Review',
    variant.headline
      ? `- Headline / Hook: ${variant.headline}`
      : '- Headline / Hook: (None provided)',
    `- Draft Body Copy / Script:\n${variant.body || '(Empty body)'}`,
    variant.callToAction
      ? `- Call to Action: ${variant.callToAction}`
      : '- Call to Action: (None provided)',
    variant.creativeDirection
      ? `- Creative Direction: ${variant.creativeDirection}`
      : '- Creative Direction: (None provided)',
    variant.notes ? `- Notes / Strategy: ${variant.notes}` : null,
    '',
    '### Editorial Review Instructions',
    'Review this exact draft variant against the Campaign context and strategy provided above:',
    '1. Alignment with Campaign objective, core angle, positioning, and target audience.',
    '2. Clarity, tone, and hook strength — detect generic AI clichés, buzzwords, or repetitive phrasing.',
    '3. Call to Action appropriateness for the specified purpose.',
    '4. Platform appropriateness based on known platform context (do not invent algorithm rules).',
    '5. Factual claims & verification risk: If the draft contains specific factual claims, statistics, or guarantees that cannot be verified from the provided context, add an issue with category "factual_verification" and message "Claim should be verified before publishing." Do NOT fabricate citations.',
    '6. Deliver an editorial verdict: "pass" if the draft is solid and ready to move forward, or "revise" if meaningful improvements are required.',
    '',
    '### Required Output Format',
    'Respond ONLY with a JSON object (inside ```json ``` code block if needed):',
    '{',
    '  "verdict": "pass" | "revise",',
    '  "summary": "1-2 sentence overall editorial assessment",',
    '  "strengths": ["Key strength 1", "Key strength 2"],',
    '  "issues": [',
    '    {',
    '      "category": "factual_verification" | "clarity" | "audience_fit" | "angle_alignment" | "cta_quality" | "platform_fit" | "tone" | "general",',
    '      "severity": "low" | "medium" | "high",',
    '      "message": "Specific explanation of the issue"',
    '    }',
    '  ],',
    '  "recommendedChanges": ["Actionable revision recommendation 1", "Actionable revision recommendation 2"]',
    '}',
  ].filter((s): s is string => s !== null)

  return sections.join('\n')
}

/**
 * Strictly parses and validates the structured Critic review output.
 * Accepts pure JSON or fenced markdown JSON (```json ... ```).
 * Rejects malformed JSON, non-object shapes, invalid verdicts (only 'pass' or 'revise'),
 * invalid severity levels, empty summaries/messages, or missing arrays.
 * Never fabricates fields from unstructured plain text.
 */
export function parseContentReviewOutput(rawOutput: string): GeneratedContentReview {
  const trimmed = (rawOutput ?? '').trim()
  if (!trimmed) {
    throw new CriticReviewParseError('Critic output is empty')
  }

  // 1. Try finding JSON within markdown code fences
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const jsonCandidate = jsonMatch?.[1] ? jsonMatch[1].trim() : trimmed

  // 2. Try parsing JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonCandidate)
  } catch {
    throw new CriticReviewParseError('Critic output is not valid JSON')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CriticReviewParseError('Critic output must be a JSON object')
  }

  const result = generatedContentReviewSchema.safeParse(parsed)
  if (!result.success) {
    throw new CriticReviewParseError(
      `Invalid Critic review schema: ${result.error.issues[0]?.message ?? result.error.message}`,
    )
  }

  return {
    verdict: result.data.verdict,
    summary: result.data.summary.trim(),
    strengths: result.data.strengths.map((s) => s.trim()),
    issues: result.data.issues.map((i) => ({
      category: i.category.trim(),
      severity: i.severity,
      message: i.message.trim(),
    })),
    recommendedChanges: result.data.recommendedChanges.map((r) => r.trim()),
  }
}
