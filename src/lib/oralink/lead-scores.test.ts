import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('default admin client must not be used in tests')
  },
}))

import { saveLeadScore } from './lead-scores'

function fakeDb(error: { message: string } | null = null) {
  const calls: { table: string; row: Record<string, unknown>; opts: unknown }[] = []
  const db = {
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, opts: unknown) => {
        calls.push({ table, row, opts })
        return Promise.resolve({ error })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, calls }
}

describe('saveLeadScore', () => {
  it('upserts one current row per contact with reasons and rules version', async () => {
    const { db, calls } = fakeDb()
    await saveLeadScore(
      {
        accountId: 'acc-1',
        contactId: 'ct-1',
        result: { score: 42, reasons: [{ rule: 'r', points: 42, valeur: 'x' }] },
        rulesVersion: 'tz-1',
      },
      db,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('lead_scores')
    expect(calls[0].opts).toEqual({ onConflict: 'contact_id' })
    expect(calls[0].row).toMatchObject({
      account_id: 'acc-1',
      contact_id: 'ct-1',
      score: 42,
      reasons: [{ rule: 'r', points: 42, valeur: 'x' }],
      rules_version: 'tz-1',
    })
  })

  it('throws when the upsert fails', async () => {
    const { db } = fakeDb({ message: 'denied' })
    await expect(
      saveLeadScore({ accountId: 'a', contactId: 'c', result: { score: 0, reasons: [] }, rulesVersion: 'v' }, db),
    ).rejects.toThrow(/denied/)
  })
})
