import { z } from 'zod'

import { execute, getDb, newId, nowIso, queryAll, queryFirst } from '~/server/db/client'
import { getNicheRefs } from '~/server/db/niche'
import { resolveAccountNiches } from '~/server/db/relations'
import type { Account, AccountStatus, ConnectionStatus, Niche } from '~/types/domain'

interface AccountRow {
  id: string
  workspace_id: string
  platform_id: string
  handle: string
  display_name: string | null
  primary_niche_id: string | null
  status: AccountStatus
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    platformId: row.platform_id,
    handle: row.handle,
    displayName: row.display_name,
    primaryNicheId: row.primary_niche_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Account plus its platform name and niche names, for list screens. */
export interface AccountSummary extends Account {
  platformName: string
  nicheNames: string[]
  /** Connection state; null means no platform connection exists yet. */
  connectionStatus: ConnectionStatus | null
}

/** An account's associated niche, with display context. */
export interface AccountNiche extends Niche {
  brandName: string
  isPrimary: boolean
}

/** Full account view for the detail screen. */
export interface AccountDetail extends Account {
  platformName: string
  niches: AccountNiche[]
  connectionStatus: ConnectionStatus | null
}

export const createAccountInput = z.object({
  workspaceId: z.uuid(),
  platformId: z.uuid(),
  handle: z
    .string()
    .trim()
    .min(1, 'Enter the account handle.')
    .max(100)
    .regex(
      /^@?[A-Za-z0-9._-]+$/,
      'Handles may contain letters, numbers, dots, dashes and underscores.',
    ),
  displayName: z.string().trim().max(120).optional(),
  nicheIds: z.array(z.uuid()).max(50).default([]),
  primaryNicheId: z.uuid().nullish(),
})
export type CreateAccountInput = z.input<typeof createAccountInput>

export const updateAccountInput = z.object({
  id: z.uuid(),
  handle: z
    .string()
    .trim()
    .min(1, 'Enter the account handle.')
    .max(100)
    .regex(
      /^@?[A-Za-z0-9._-]+$/,
      'Handles may contain letters, numbers, dots, dashes and underscores.',
    ),
  displayName: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  nicheIds: z.array(z.uuid()).max(50).optional(),
  primaryNicheId: z.uuid().nullish(),
})
export type UpdateAccountInput = z.input<typeof updateAccountInput>

async function getConnectionStatus(accountId: string): Promise<ConnectionStatus | null> {
  const row = await queryFirst<{ status: ConnectionStatus }>(
    getDb(),
    `SELECT status FROM platform_connection WHERE account_id = ?`,
    [accountId],
  )
  return row ? row.status : null
}

async function listAccountNicheNames(accountId: string): Promise<string[]> {
  const rows = await queryAll<{ name: string }>(
    getDb(),
    `SELECT n.name FROM account_niche an
     JOIN niche n ON n.id = an.niche_id
     WHERE an.account_id = ? AND n.deleted_at IS NULL
     ORDER BY n.name ASC`,
    [accountId],
  )
  return rows.map((row) => row.name)
}

/** Active accounts of a workspace. */
export async function listAccounts(workspaceId: string): Promise<AccountSummary[]> {
  const rows = await queryAll<AccountRow & { platform_name: string }>(
    getDb(),
    `SELECT a.*, p.name AS platform_name
     FROM account a JOIN platform p ON p.id = a.platform_id
     WHERE a.workspace_id = ? AND a.deleted_at IS NULL AND a.status != 'archived'
     ORDER BY a.created_at DESC`,
    [workspaceId],
  )
  const summaries: AccountSummary[] = []
  for (const row of rows) {
    summaries.push({
      ...toAccount(row),
      platformName: row.platform_name,
      nicheNames: await listAccountNicheNames(row.id),
      connectionStatus: await getConnectionStatus(row.id),
    })
  }
  return summaries
}

/** Archived accounts of a workspace, restorable. */
export async function listArchivedAccounts(workspaceId: string): Promise<AccountSummary[]> {
  const rows = await queryAll<AccountRow & { platform_name: string }>(
    getDb(),
    `SELECT a.*, p.name AS platform_name
     FROM account a JOIN platform p ON p.id = a.platform_id
     WHERE a.workspace_id = ? AND a.deleted_at IS NULL AND a.status = 'archived'
     ORDER BY a.updated_at DESC`,
    [workspaceId],
  )
  const summaries: AccountSummary[] = []
  for (const row of rows) {
    summaries.push({
      ...toAccount(row),
      platformName: row.platform_name,
      nicheNames: await listAccountNicheNames(row.id),
      connectionStatus: await getConnectionStatus(row.id),
    })
  }
  return summaries
}

export async function getAccountById(id: string): Promise<Account | null> {
  const row = await queryFirst<AccountRow>(getDb(), `SELECT * FROM account WHERE id = ?`, [id])
  return row ? toAccount(row) : null
}

/** Full detail: account + platform + associated niches + connection state. */
export async function getAccountDetail(id: string): Promise<AccountDetail | null> {
  const account = await getAccountById(id)
  if (!account) {
    return null
  }
  const platform = await queryFirst<{ name: string }>(
    getDb(),
    `SELECT name FROM platform WHERE id = ?`,
    [account.platformId],
  )
  const nicheRows = await queryAll<{
    id: string
    brand_id: string
    name: string
    description: string | null
    created_at: string
    updated_at: string
    deleted_at: string | null
    brand_name: string
  }>(
    getDb(),
    `SELECT n.*, b.name AS brand_name
     FROM account_niche an
     JOIN niche n ON n.id = an.niche_id
     JOIN brand b ON b.id = n.brand_id
     WHERE an.account_id = ?
     ORDER BY b.name ASC, n.name ASC`,
    [id],
  )
  return {
    ...account,
    platformName: platform?.name ?? 'Unknown platform',
    niches: nicheRows.map((row) => ({
      id: row.id,
      brandId: row.brand_id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      brandName: row.brand_name,
      isPrimary: account.primaryNicheId === row.id,
    })),
    connectionStatus: await getConnectionStatus(id),
  }
}

async function assertHandleAvailable(
  platformId: string,
  handle: string,
  exceptAccountId?: string,
): Promise<void> {
  const row = await queryFirst<{ id: string }>(
    getDb(),
    `SELECT id FROM account WHERE platform_id = ? AND handle = ? AND deleted_at IS NULL`,
    [platformId, handle],
  )
  if (row && row.id !== exceptAccountId) {
    throw new Error('An account with this handle already exists on that platform.')
  }
}

async function assertPlatformExists(platformId: string): Promise<void> {
  const row = await queryFirst<{ id: string }>(getDb(), `SELECT id FROM platform WHERE id = ?`, [
    platformId,
  ])
  if (!row) {
    throw new Error('Choose a platform for this account.')
  }
}

/**
 * Validate the requested niche ids against the workspace and the primary
 * niche. Returns the normalized associations to persist.
 */
async function validateNiches(
  workspaceId: string,
  nicheIds: string[],
  primaryNicheId: string | null | undefined,
): Promise<{ nicheIds: string[]; primaryNicheId: string | null }> {
  const refs = await getNicheRefs(nicheIds)
  if (refs.length !== new Set(nicheIds).size) {
    throw new Error('One of the selected niches no longer exists.')
  }
  return resolveAccountNiches(refs, workspaceId, primaryNicheId)
}

async function replaceAccountNiches(accountId: string, nicheIds: string[]): Promise<void> {
  await execute(getDb(), `DELETE FROM account_niche WHERE account_id = ?`, [accountId])
  const now = nowIso()
  for (const nicheId of nicheIds) {
    await execute(
      getDb(),
      `INSERT INTO account_niche (account_id, niche_id, created_at) VALUES (?, ?, ?)`,
      [accountId, nicheId, now],
    )
  }
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const data = createAccountInput.parse(input)
  await assertPlatformExists(data.platformId)
  await assertHandleAvailable(data.platformId, data.handle)
  const niches = await validateNiches(data.workspaceId, data.nicheIds, data.primaryNicheId)
  const id = newId()
  const now = nowIso()
  await execute(
    getDb(),
    `INSERT INTO account (id, workspace_id, platform_id, handle, display_name, primary_niche_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      data.workspaceId,
      data.platformId,
      data.handle,
      data.displayName ?? null,
      niches.primaryNicheId,
      now,
      now,
    ],
  )
  await replaceAccountNiches(id, niches.nicheIds)
  const created = await getAccountById(id)
  if (!created) {
    throw new Error('account insert did not produce a readable row')
  }
  return created
}

export async function updateAccount(input: UpdateAccountInput): Promise<Account> {
  const data = updateAccountInput.parse(input)
  const existing = await getAccountById(data.id)
  if (!existing) {
    throw new Error('Account not found.')
  }
  if (existing.status === 'archived') {
    throw new Error('This account is archived. Restore it before making changes.')
  }
  await assertHandleAvailable(existing.platformId, data.handle, data.id)

  // Niche associations only change when the caller passes nicheIds; the
  // primary niche is always validated against the resulting set.
  let primaryNicheId =
    data.primaryNicheId !== undefined ? data.primaryNicheId : existing.primaryNicheId
  if (data.nicheIds !== undefined) {
    const niches = await validateNiches(existing.workspaceId, data.nicheIds, primaryNicheId)
    await replaceAccountNiches(data.id, niches.nicheIds)
    primaryNicheId = niches.primaryNicheId
  } else if (primaryNicheId) {
    const currentIds = (
      await queryAll<{ niche_id: string }>(
        getDb(),
        `SELECT niche_id FROM account_niche WHERE account_id = ?`,
        [data.id],
      )
    ).map((row) => row.niche_id)
    const refs = await getNicheRefs([primaryNicheId])
    const ref = refs[0]
    if (!ref || ref.deletedAt || !currentIds.includes(primaryNicheId)) {
      throw new Error("The primary niche must be one of the account's niches.")
    }
  }

  await execute(
    getDb(),
    `UPDATE account
     SET handle = ?, display_name = ?, primary_niche_id = ?,
         status = COALESCE(?, status), updated_at = ?
     WHERE id = ?`,
    [
      data.handle,
      data.displayName ?? null,
      primaryNicheId ?? null,
      data.status ?? null,
      nowIso(),
      data.id,
    ],
  )
  const updated = await getAccountById(data.id)
  if (!updated) {
    throw new Error('account update did not produce a readable row')
  }
  return updated
}

/** Archive = status change; niche links and history stay. */
export async function archiveAccount(id: string): Promise<void> {
  const existing = await getAccountById(id)
  if (!existing) {
    throw new Error('Account not found.')
  }
  await execute(getDb(), `UPDATE account SET status = 'archived', updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
}

export async function restoreAccount(id: string): Promise<void> {
  const existing = await getAccountById(id)
  if (!existing) {
    throw new Error('Account not found.')
  }
  await execute(getDb(), `UPDATE account SET status = 'active', updated_at = ? WHERE id = ?`, [
    nowIso(),
    id,
  ])
}
