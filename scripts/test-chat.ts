/**
 * Conversation/message repository tests (npm run test:chat).
 *
 * Runs the real repositories (src/server/db/conversation.ts and message.ts)
 * against a fresh better-sqlite3 database migrated from migrations/. The
 * repositories take a structural SqlDatabase, which better-sqlite3 satisfies
 * via the shim below — the same SQL the Worker runs, tested in plain node.
 *
 * Covers: create, append, ordering, workspace isolation, invalid ids,
 * archive/restore behavior, rename, scope validation, and the role policy
 * (client path can only write 'user' messages).
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  archiveConversation,
  createConversation,
  deriveConversationTitle,
  getConversationById,
  getConversationSummary,
  listArchivedConversations,
  listConversations,
  renameConversation,
  restoreConversation,
} from '../src/server/db/conversation.ts'
import {
  appendMessage,
  appendUserMessage,
  listMessages,
  MAX_MESSAGE_CHARS,
} from '../src/server/db/message.ts'
import type { SqlDatabase } from '../src/server/db/sql.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** better-sqlite3 → structural SqlDatabase (D1 prepared-statement shape). */
function shim(db: Database.Database): SqlDatabase {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      return {
        bind(...params: unknown[]) {
          return {
            all: async <Row>() => ({ results: stmt.all(...params) as Row[] }),
            first: async <Row>() => (stmt.get(...params) as Row | undefined) ?? null,
            run: async () => stmt.run(...params),
          }
        },
      }
    },
  }
}

const WS1 = crypto.randomUUID()
const WS2 = crypto.randomUUID()
const BRAND_WS1 = crypto.randomUUID()
const BRAND_WS2 = crypto.randomUUID()
const NOW = '2026-08-19T00:00:00.000Z'

function freshDb(): SqlDatabase {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const dir = join(ROOT, 'migrations')
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(join(dir, file), 'utf8'))
  }
  const insertWorkspace = sqlite.prepare(
    `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
  )
  insertWorkspace.run(WS1, 'One', NOW, NOW)
  insertWorkspace.run(WS2, 'Two', NOW, NOW)
  const insertBrand = sqlite.prepare(
    `INSERT INTO brand (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`,
  )
  insertBrand.run(BRAND_WS1, WS1, 'Brand One', NOW, NOW)
  insertBrand.run(BRAND_WS2, WS2, 'Brand Two', NOW, NOW)
  return shim(sqlite)
}

test('create conversation: general and brand-scoped', async () => {
  const db = freshDb()
  const general = await createConversation(db, { workspaceId: WS1 })
  assert.equal(general.workspaceId, WS1)
  assert.equal(general.title, null)
  assert.equal(general.scopeType, null)
  assert.equal(general.scopeId, null)

  const scoped = await createConversation(db, {
    workspaceId: WS1,
    title: 'Review campaign',
    scopeType: 'brand',
    scopeId: BRAND_WS1,
  })
  assert.equal(scoped.title, 'Review campaign')
  assert.equal(scoped.scopeType, 'brand')
  assert.equal(scoped.scopeId, BRAND_WS1)

  const summary = await getConversationSummary(db, scoped.id)
  assert.equal(summary?.scopeName, 'Brand One')
  assert.equal(summary?.messageCount, 0)
})

test('scope validation rejects cross-workspace, archived, unknown, unpaired', async () => {
  const db = freshDb()
  await assert.rejects(
    createConversation(db, { workspaceId: WS1, scopeType: 'brand', scopeId: BRAND_WS2 }),
    /not available/,
  )
  await assert.rejects(
    createConversation(db, {
      workspaceId: WS1,
      scopeType: 'brand',
      scopeId: crypto.randomUUID(),
    }),
    /not available/,
  )
  await assert.rejects(
    createConversation(db, { workspaceId: WS1, scopeType: 'brand' }),
    /set together/,
  )
  await assert.rejects(
    createConversation(db, { workspaceId: WS1, scopeId: BRAND_WS1 }),
    /set together/,
  )

  // Archived scope target
  const archivedBrand = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO brand (id, workspace_id, name, created_at, updated_at, deleted_at) VALUES (?, ?, 'Old', ?, ?, ?)`,
    )
    .bind(archivedBrand, WS1, NOW, NOW, NOW)
    .run()
  await assert.rejects(
    createConversation(db, { workspaceId: WS1, scopeType: 'brand', scopeId: archivedBrand }),
    /archived/,
  )
})

test('append user message + ordering by insertion', async () => {
  const db = freshDb()
  const conversation = await createConversation(db, { workspaceId: WS1 })
  await appendUserMessage(db, { conversationId: conversation.id, content: 'first' })
  await appendUserMessage(db, { conversationId: conversation.id, content: 'second' })
  await appendUserMessage(db, { conversationId: conversation.id, content: 'third' })

  const messages = await listMessages(db, conversation.id)
  assert.deepEqual(
    messages.map((m) => m.content),
    ['first', 'second', 'third'],
  )
  assert.ok(messages.every((m) => m.senderType === 'user'))

  const summary = await getConversationSummary(db, conversation.id)
  assert.equal(summary?.messageCount, 3)
  assert.equal(summary?.lastMessagePreview, 'third')
})

test('workspace isolation: lists only see their own workspace', async () => {
  const db = freshDb()
  await createConversation(db, { workspaceId: WS1, title: 'ws1 chat' })
  await createConversation(db, { workspaceId: WS2, title: 'ws2 chat' })

  const ws1List = await listConversations(db, WS1)
  assert.equal(ws1List.length, 1)
  assert.equal(ws1List[0]?.title, 'ws1 chat')
  const ws2List = await listConversations(db, WS2)
  assert.equal(ws2List.length, 1)
  assert.equal(ws2List[0]?.title, 'ws2 chat')
})

test('archive and restore move conversations between lists', async () => {
  const db = freshDb()
  const conversation = await createConversation(db, { workspaceId: WS1, title: 'to archive' })

  await archiveConversation(db, conversation.id)
  assert.equal((await listConversations(db, WS1)).length, 0)
  const archived = await listArchivedConversations(db, WS1)
  assert.equal(archived.length, 1)
  assert.equal(archived[0]?.id, conversation.id)

  // Messages survive archiving (history is preserved).
  const after = await getConversationById(db, conversation.id)
  assert.ok(after?.deletedAt)

  await restoreConversation(db, conversation.id)
  assert.equal((await listConversations(db, WS1)).length, 1)
  assert.equal((await listArchivedConversations(db, WS1)).length, 0)

  // Archiving an unknown conversation rejects.
  await assert.rejects(archiveConversation(db, crypto.randomUUID()), /not found/i)
})

test('rename works and rejects unknown conversations', async () => {
  const db = freshDb()
  const conversation = await createConversation(db, { workspaceId: WS1 })
  const renamed = await renameConversation(db, { id: conversation.id, title: '  New name  ' })
  assert.equal(renamed.title, 'New name')
  await assert.rejects(
    renameConversation(db, { id: crypto.randomUUID(), title: 'nope' }),
    /not found/i,
  )
  await assert.rejects(renameConversation(db, { id: conversation.id, title: '   ' }))
})

test('message content validation: empty and oversized rejected', async () => {
  const db = freshDb()
  const conversation = await createConversation(db, { workspaceId: WS1 })
  await assert.rejects(
    appendUserMessage(db, { conversationId: conversation.id, content: '   ' }),
    /Write a message/,
  )
  await assert.rejects(
    appendUserMessage(db, {
      conversationId: conversation.id,
      content: 'x'.repeat(MAX_MESSAGE_CHARS + 1),
    }),
    /under/,
  )
})

test('role policy: client path is user-only, agent writes stay server-side', async () => {
  const db = freshDb()
  const conversation = await createConversation(db, { workspaceId: WS1 })

  // The client-facing path fixes the role; there is no role parameter to spoof.
  const userMessage = await appendUserMessage(db, {
    conversationId: conversation.id,
    content: 'hello',
  })
  assert.equal(userMessage.senderType, 'user')
  assert.equal(userMessage.agentId, null)

  // The trusted path accepts agent/system roles for future AI execution...
  const agentMessage = await appendMessage(db, {
    conversationId: conversation.id,
    senderType: 'agent',
    content: 'trusted reply',
  })
  assert.equal(agentMessage.senderType, 'agent')

  // ...but never an out-of-vocabulary role.
  await assert.rejects(
    appendMessage(db, {
      conversationId: conversation.id,
      // @ts-expect-error deliberately invalid role
      senderType: 'assistant',
      content: 'spoofed',
    }),
  )

  const messages = await listMessages(db, conversation.id)
  assert.deepEqual(
    messages.map((m) => m.senderType),
    ['user', 'agent'],
  )
})

test('deriveConversationTitle uses the first line, truncated', () => {
  assert.equal(deriveConversationTitle('  Hello there\nsecond line'), 'Hello there')
  assert.equal(deriveConversationTitle('x'.repeat(100)).length, 61)
  assert.equal(deriveConversationTitle('short'), 'short')
})
