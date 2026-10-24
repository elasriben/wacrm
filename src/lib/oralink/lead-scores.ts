/**
 * OraLink — persistence of a computed score into `lead_scores` (migration 901_oralink_lead_scores).
 * One current row per contact (UNIQUE contact_id): a recompute overwrites it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import type { ScoreResult } from './scoring'

export async function saveLeadScore(
  args: {
    accountId: string
    contactId: string
    result: ScoreResult
    rulesVersion: string
  },
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  const { error } = await db.from('lead_scores').upsert(
    {
      account_id: args.accountId,
      contact_id: args.contactId,
      score: args.result.score,
      reasons: args.result.reasons,
      rules_version: args.rulesVersion,
      computed_at: new Date().toISOString(),
    },
    { onConflict: 'contact_id' },
  )
  if (error) throw new Error(`saveLeadScore failed: ${error.message}`)
}
