import type { AIProviderAdapter } from '../types.ts'

/**
 * Offline development adapter ('echo'). Exists so the chat loop can be
 * exercised without a Cloudflare account; it never claims to be a real
 * model and its output is clearly marked. Activate ONLY for local
 * development with AI_PROVIDER=echo (see docs/ai-execution.md). Production
 * must use a real provider.
 */
export function createEchoAdapter(): AIProviderAdapter {
  return {
    key: 'echo',
    async execute({ messages }) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const excerpt = (lastUser?.content ?? '').slice(0, 120)
      return {
        content: [
          '[offline dev echo — no real model is configured]',
          '',
          excerpt ? `You said: “${excerpt}”` : 'Nothing to echo.',
          '',
          'Set up the Workers AI binding (see docs/ai-execution.md) to get real Chief replies.',
        ].join('\n'),
        finishReason: 'stop',
        usage: null,
      }
    },
  }
}
