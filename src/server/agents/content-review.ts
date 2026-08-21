import type {
  CampaignContentItem,
  IssueSeverity,
  ReviewIssue,
  ReviewVerdict,
} from '../../types/domain.ts'
import { sha256Hex } from '../approval/snapshot.ts'
import type { ContentVariantDetail } from '../db/content-variant.ts'

export interface GeneratedContentReview {
  verdict: ReviewVerdict
  summary: string
  strengths: string[]
  issues: ReviewIssue[]
  recommendedChanges: string[]
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

function normalizeSeverity(raw: unknown): IssueSeverity {
  if (typeof raw === 'string') {
    const s = raw.toLowerCase().trim()
    if (s === 'high') return 'high'
    if (s === 'low') return 'low'
  }
  return 'medium'
}

function normalizeVerdict(raw: unknown): ReviewVerdict {
  if (typeof raw === 'string') {
    const v = raw.toLowerCase().trim()
    if (v === 'pass' || v === 'approved' || v === 'accept') return 'pass'
  }
  return 'revise'
}

/**
 * Safely parse structured Critic review response.
 * Resilient against markdown code fences, malformed keys, or missing arrays.
 */
export function parseContentReviewOutput(rawOutput: string): GeneratedContentReview {
  const trimmed = rawOutput.trim()
  if (!trimmed) {
    return {
      verdict: 'revise',
      summary: 'No review output was provided by the Critic agent.',
      strengths: [],
      issues: [
        {
          category: 'general',
          severity: 'high',
          message: 'Critic output was empty.',
        },
      ],
      recommendedChanges: ['Re-run editorial review with the Critic agent.'],
    }
  }

  // 1. Try finding JSON within markdown code fences
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const jsonCandidate = jsonMatch?.[1] ? jsonMatch[1].trim() : trimmed

  // 2. Try parsing JSON
  try {
    const parsed = JSON.parse(jsonCandidate)
    if (parsed && typeof parsed === 'object') {
      const verdict = normalizeVerdict(parsed.verdict)
      const summary =
        typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : verdict === 'pass'
            ? 'Draft meets editorial requirements.'
            : 'Draft requires revisions before moving forward.'

      const strengths: string[] = []
      if (Array.isArray(parsed.strengths)) {
        for (const item of parsed.strengths) {
          if (typeof item === 'string' && item.trim().length > 0) {
            strengths.push(item.trim())
          }
        }
      }

      const issues: ReviewIssue[] = []
      if (Array.isArray(parsed.issues)) {
        for (const item of parsed.issues) {
          if (item && typeof item === 'object') {
            const msg =
              typeof item.message === 'string' && item.message.trim().length > 0
                ? item.message.trim()
                : typeof item.issue === 'string'
                  ? item.issue.trim()
                  : 'Unspecified issue'
            const cat =
              typeof item.category === 'string' && item.category.trim().length > 0
                ? item.category.trim()
                : 'general'
            const sev = normalizeSeverity(item.severity)
            issues.push({ category: cat, severity: sev, message: msg })
          } else if (typeof item === 'string' && item.trim().length > 0) {
            issues.push({ category: 'general', severity: 'medium', message: item.trim() })
          }
        }
      }

      const recommendedChanges: string[] = []
      if (Array.isArray(parsed.recommendedChanges)) {
        for (const item of parsed.recommendedChanges) {
          if (typeof item === 'string' && item.trim().length > 0) {
            recommendedChanges.push(item.trim())
          }
        }
      } else if (Array.isArray(parsed.recommendations)) {
        for (const item of parsed.recommendations) {
          if (typeof item === 'string' && item.trim().length > 0) {
            recommendedChanges.push(item.trim())
          }
        }
      }

      return {
        verdict,
        summary,
        strengths,
        issues,
        recommendedChanges,
      }
    }
  } catch {
    // Fallback if model returned plain text instead of JSON
  }

  // 3. Fallback extraction for plain text
  const isPass = /\b(pass|passed|ready|strong|no major issues)\b/i.test(trimmed)
  return {
    verdict: isPass ? 'pass' : 'revise',
    summary: trimmed.slice(0, 300),
    strengths: isPass ? ['Overall copy aligns well with campaign direction.'] : [],
    issues: isPass
      ? []
      : [
          {
            category: 'general',
            severity: 'medium',
            message: 'See Critic feedback summary for detailed recommendations.',
          },
        ],
    recommendedChanges: isPass ? [] : ['Review critic summary and refine draft copy.'],
  }
}
