import { Link, useNavigate } from '@tanstack/react-router'
import { ExternalLink, FlaskConical, Loader2, Sparkles } from 'lucide-react'
import { useState, useTransition } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import type { CampaignDetail, CampaignResearchItem } from '~/server/db/campaign'
import { startCampaignResearchChatFn } from './server'

interface CampaignResearchSectionProps {
  campaign: CampaignDetail
}

function freshnessTone(freshness: string): 'success' | 'warning' | 'muted' | 'neutral' {
  switch (freshness) {
    case 'current':
      return 'success'
    case 'aging':
      return 'warning'
    case 'stale':
    case 'expired':
      return 'muted'
    default:
      return 'neutral'
  }
}

function statusTone(status: string): 'success' | 'warning' | 'muted' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'success'
    case 'in_progress':
      return 'warning'
    case 'draft':
      return 'muted'
    default:
      return 'neutral'
  }
}

export function CampaignResearchSection({ campaign }: CampaignResearchSectionProps) {
  const navigate = useNavigate()
  const [isStartingChat, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const handleResearchCampaign = () => {
    setError(null)
    startTransition(async () => {
      try {
        const result = await startCampaignResearchChatFn({
          data: { campaignId: campaign.id },
        })
        if (result?.conversationId) {
          navigate({
            to: '/chat/$conversationId',
            params: { conversationId: result.conversationId },
            search: result.agentId ? { agent: result.agentId } : {},
          })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to launch research chat.')
      }
    })
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
            <FlaskConical className="size-4 text-zinc-500" />
            Campaign Research ({campaign.researchCount})
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Verified findings and intelligence scoped to this campaign and brand.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            to="/research"
            className="text-xs font-medium text-zinc-500 hover:text-zinc-700 hover:underline inline-flex items-center gap-1"
          >
            All Research
            <ExternalLink className="size-3" />
          </Link>
          <Button
            variant="secondary"
            onClick={handleResearchCampaign}
            disabled={isStartingChat}
            className="text-xs h-7 px-2.5"
          >
            {isStartingChat ? (
              <>
                <Loader2 className="size-3.5 animate-spin mr-1.5" />
                Opening Researcher...
              </>
            ) : (
              <>
                <FlaskConical className="size-3.5 mr-1.5 text-blue-600" />
                Research this campaign
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
          {error}
        </div>
      )}

      {campaign.recentResearch.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center space-y-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-blue-50 text-blue-600 mx-auto">
            <FlaskConical className="size-5" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-zinc-800">No linked research records yet</p>
            <p className="text-xs text-zinc-400 max-w-sm mx-auto">
              Conduct audience, competitor, or angle research with the Researcher agent to support
              this campaign.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={handleResearchCampaign}
            disabled={isStartingChat}
            className="text-xs"
          >
            {isStartingChat ? (
              <Loader2 className="size-3.5 animate-spin mr-1.5" />
            ) : (
              <Sparkles className="size-3.5 mr-1.5 text-blue-600" />
            )}
            Start Campaign Research
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-zinc-100">
          {campaign.recentResearch.map((res: CampaignResearchItem) => (
            <div
              key={res.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between py-3 gap-2"
            >
              <div className="space-y-1 min-w-0">
                <Link
                  to="/research"
                  search={{ search: res.subject }}
                  className="text-xs font-medium text-zinc-900 hover:text-blue-600 hover:underline line-clamp-1"
                >
                  {res.subject}
                </Link>
                <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                  <span className="capitalize">{res.researchType} Research</span>
                  <span>•</span>
                  <span>{res.provenance?.label ?? 'User-entered'}</span>
                  {res.scopeType === 'campaign' && (
                    <>
                      <span>•</span>
                      <span className="text-blue-600 font-medium">Campaign Scoped</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
                <Badge tone={freshnessTone(res.freshness)}>{res.freshness}</Badge>
                <Badge tone={statusTone(res.status)}>{res.status}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
