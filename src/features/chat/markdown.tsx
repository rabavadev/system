import type { ReactNode } from 'react'

import { cn } from '~/lib/utils'

/**
 * Minimal, safe Markdown renderer for Chief responses. Produces React
 * elements directly (never HTML strings), so injection is impossible by
 * construction — no dangerouslySetInnerHTML, no sanitize step needed.
 *
 * Supports: paragraphs, # / ## / ### headings, - and * bullets, 1. numbered
 * lists, ``` fenced code blocks, `inline code`, **bold**, *italic*, and
 * [links](https://…) restricted to http(s).
 */

type InlineToken = {
  kind: 'text' | 'bold' | 'italic' | 'code' | 'link'
  text: string
  href?: string
}

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      tokens.push({ kind: 'text', text: text.slice(lastIndex, index) })
    }
    const raw = match[0]
    if (raw.startsWith('**')) {
      tokens.push({ kind: 'bold', text: raw.slice(2, -2) })
    } else if (raw.startsWith('*')) {
      tokens.push({ kind: 'italic', text: raw.slice(1, -1) })
    } else if (raw.startsWith('`')) {
      tokens.push({ kind: 'code', text: raw.slice(1, -1) })
    } else {
      const label = raw.slice(1, raw.indexOf(']'))
      tokens.push({ kind: 'link', text: label, href: match[2] ?? '' })
    }
    lastIndex = index + raw.length
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', text: text.slice(lastIndex) })
  }
  return tokens
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return tokenizeInline(text).map((token, i) => {
    const key = `${keyPrefix}-${i}`
    switch (token.kind) {
      case 'bold':
        return (
          <strong key={key} className="font-semibold text-zinc-900">
            {token.text}
          </strong>
        )
      case 'italic':
        return <em key={key}>{token.text}</em>
      case 'code':
        return (
          <code
            key={key}
            className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.8125rem] text-zinc-800"
          >
            {token.text}
          </code>
        )
      case 'link':
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500"
          >
            {token.text}
          </a>
        )
      default:
        return <span key={key}>{token.text}</span>
    }
  })
}

interface Block {
  kind: 'paragraph' | 'heading' | 'code' | 'list'
  level?: number
  ordered?: boolean
  lines: string[]
}

function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (line.trimStart().startsWith('```')) {
      const code: string[] = []
      i += 1
      let codeLine = lines[i] ?? ''
      while (i < lines.length && !codeLine.trimStart().startsWith('```')) {
        code.push(codeLine)
        i += 1
        codeLine = lines[i] ?? ''
      }
      i += 1 // closing fence (or EOF)
      blocks.push({ kind: 'code', lines: code })
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1]?.length ?? 1,
        lines: [heading[2] ?? ''],
      })
      i += 1
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      let item = lines[i] ?? ''
      while (i < lines.length && /^\s*[-*]\s+/.test(item)) {
        items.push(item.replace(/^\s*[-*]\s+/, ''))
        i += 1
        item = lines[i] ?? ''
      }
      blocks.push({ kind: 'list', ordered: false, lines: items })
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      let item = lines[i] ?? ''
      while (i < lines.length && /^\s*\d+\.\s+/.test(item)) {
        items.push(item.replace(/^\s*\d+\.\s+/, ''))
        i += 1
        item = lines[i] ?? ''
      }
      blocks.push({ kind: 'list', ordered: true, lines: items })
      continue
    }
    const paragraph: string[] = []
    let current = lines[i] ?? ''
    while (
      i < lines.length &&
      current.trim() !== '' &&
      !/^(#{1,3})\s/.test(current) &&
      !/^\s*([-*]|\d+\.)\s+/.test(current) &&
      !current.trimStart().startsWith('```')
    ) {
      paragraph.push(current)
      i += 1
      current = lines[i] ?? ''
    }
    blocks.push({ kind: 'paragraph', lines: paragraph })
  }
  return blocks
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = splitBlocks(text)
  return (
    <div className={cn('flex flex-col gap-2 text-sm leading-6 text-zinc-800', className)}>
      {blocks.map((block, index) => {
        const key = `b${index}`
        if (block.kind === 'heading') {
          const size = block.level === 1 ? 'text-sm' : block.level === 2 ? 'text-[13px]' : 'text-xs'
          return (
            <p key={key} className={cn('pt-1 font-semibold text-zinc-900', size)}>
              {renderInline(block.lines[0] ?? '', key)}
            </p>
          )
        }
        if (block.kind === 'code') {
          return (
            <pre
              key={key}
              className="overflow-x-auto rounded-md bg-zinc-900 px-3 py-2 font-mono text-xs leading-5 text-zinc-100"
            >
              {block.lines.join('\n')}
            </pre>
          )
        }
        if (block.kind === 'list') {
          const items = block.lines.map((item, itemIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parsed list items are static per render and have no id
            <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))
          return block.ordered ? (
            <ol key={key} className="flex list-decimal flex-col gap-1 pl-5">
              {items}
            </ol>
          ) : (
            <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
              {items}
            </ul>
          )
        }
        return <p key={key}>{renderInline(block.lines.join(' '), key)}</p>
      })}
    </div>
  )
}
