/**
 * OraLink — consent guard for broadcast fan-out (CONTRACTS §5).
 *
 * `deliverBroadcast` only holds recipient row ids and phones, not the
 * account or contact ids, and its plan shape is shared with the resume
 * path. Rather than changing that shape, the guard resolves
 * broadcast → account and recipient rows → contacts, then applies the same
 * rule as `canSendAutomated` (`blockedContactIds`).
 *
 * Throws on any lookup error: the caller must fail closed (send nothing).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { blockedContactIds } from './consent'

export const BROADCAST_OPT_OUT_ERROR = 'Blocked: contact opted out (STOP)'

const IN_CHUNK = 200

/** Returns the recipient row ids, among `recipientRowIds`, that must not be sent. */
export async function blockedBroadcastRecipientRows(
  db: SupabaseClient,
  broadcastId: string,
  recipientRowIds: readonly string[],
): Promise<Set<string>> {
  const blocked = new Set<string>()
  if (recipientRowIds.length === 0) return blocked

  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .select('account_id')
    .eq('id', broadcastId)
    .single()
  if (bErr || !broadcast?.account_id) {
    throw new Error(`broadcast account lookup failed: ${bErr?.message ?? 'not found'}`)
  }
  const accountId = broadcast.account_id as string

  const contactByRow = new Map<string, string>()
  for (let i = 0; i < recipientRowIds.length; i += IN_CHUNK) {
    const chunk = recipientRowIds.slice(i, i + IN_CHUNK)
    const { data, error } = await db
      .from('broadcast_recipients')
      .select('id, contact_id')
      .eq('broadcast_id', broadcastId)
      .in('id', chunk)
    if (error) throw new Error(`recipient lookup failed: ${error.message}`)
    for (const row of (data ?? []) as { id: string; contact_id: string | null }[]) {
      if (row.contact_id) contactByRow.set(row.id, row.contact_id)
    }
  }

  const blockedIds = await blockedContactIds(accountId, [...contactByRow.values()], db)
  for (const rowId of recipientRowIds) {
    const contactId = contactByRow.get(rowId)
    // A row we cannot tie to a contact of this broadcast has no consent
    // state we can check: fail closed for that row.
    if (!contactId || blockedIds.has(contactId)) blocked.add(rowId)
  }
  return blocked
}
