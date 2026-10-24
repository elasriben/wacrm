import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('default admin client must not be used in tests')
  },
}))

import {
  assertCanSendAutomated,
  blockedContactIds,
  blockedPhones,
  canSendAutomated,
  ConsentBlockedError,
  ConsentError,
  getConsentState,
  recordConsent,
} from './consent'

type Row = Record<string, unknown>

/** Minimal PostgREST-shaped fake: select/eq/in filters + insert, awaitable. */
function fakeDb(tables: Record<string, Row[]>, opts: { failOn?: string } = {}) {
  const inserts: { table: string; rows: Row[] }[] = []
  const db = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => {
          filters.push((r) => r[c] === v)
          return builder
        },
        in: (c: string, vs: unknown[]) => {
          filters.push((r) => vs.includes(r[c]))
          return builder
        },
        insert: (rows: Row[] | Row) => {
          const list = Array.isArray(rows) ? rows : [rows]
          inserts.push({ table, rows: list })
          if (opts.failOn !== table) (tables[table] ??= []).push(...list)
          return Promise.resolve({
            data: null,
            error: opts.failOn === table ? { message: 'boom' } : null,
          })
        },
        then: (resolve: (r: unknown) => unknown) =>
          resolve(
            opts.failOn === table
              ? { data: null, error: { message: 'boom' } }
              : { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null },
          ),
      }
      return builder
    },
  }
  return { db: db as unknown as SupabaseClient, inserts }
}

const A = 'acc-1'
const C = 'ct-1'

function current(rows: Partial<Row>[]): Row[] {
  return rows.map((r) => ({ account_id: A, contact_id: C, channel: 'whatsapp', ...r }))
}

describe('canSendAutomated', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('allows a contact with no consent history (status quo)', async () => {
    const { db } = fakeDb({ contact_consent_current: [] })
    expect(await canSendAutomated(A, C, db)).toBe(true)
  })

  it('allows when every purpose is granted', async () => {
    const { db } = fakeDb({
      contact_consent_current: current([
        { purpose: 'service', status: 'granted' },
        { purpose: 'marketing', status: 'granted' },
      ]),
    })
    expect(await canSendAutomated(A, C, db)).toBe(true)
  })

  it('blocks after STOP (both purposes revoked)', async () => {
    const { db } = fakeDb({
      contact_consent_current: current([
        { purpose: 'service', status: 'revoked' },
        { purpose: 'marketing', status: 'revoked' },
      ]),
    })
    expect(await canSendAutomated(A, C, db)).toBe(false)
  })

  it('blocks when only marketing is revoked (conservative, no purpose arg)', async () => {
    const { db } = fakeDb({
      contact_consent_current: current([
        { purpose: 'service', status: 'granted' },
        { purpose: 'marketing', status: 'revoked' },
      ]),
    })
    expect(await canSendAutomated(A, C, db)).toBe(false)
  })

  it('ignores another account’s revocation for the same contact id', async () => {
    const { db } = fakeDb({
      contact_consent_current: [
        { account_id: 'acc-2', contact_id: C, channel: 'whatsapp', purpose: 'service', status: 'revoked' },
      ],
    })
    expect(await canSendAutomated(A, C, db)).toBe(true)
  })

  it('fails closed on lookup error', async () => {
    const { db } = fakeDb({}, { failOn: 'contact_consent_current' })
    expect(await canSendAutomated(A, C, db)).toBe(false)
    expect(console.error).toHaveBeenCalled()
  })

  it('assertCanSendAutomated throws ConsentBlockedError when blocked', async () => {
    const { db } = fakeDb({
      contact_consent_current: current([{ purpose: 'service', status: 'revoked' }]),
    })
    await expect(assertCanSendAutomated(A, C, db)).rejects.toBeInstanceOf(ConsentBlockedError)
    const ok = fakeDb({ contact_consent_current: [] })
    await expect(assertCanSendAutomated(A, C, ok.db)).resolves.toBeUndefined()
  })
})

describe('getConsentState', () => {
  it('maps purposes to their latest status', async () => {
    const { db } = fakeDb({
      contact_consent_current: current([
        { purpose: 'service', status: 'granted' },
        { purpose: 'marketing', status: 'revoked' },
      ]),
    })
    expect(await getConsentState(A, C, db)).toEqual({ service: 'granted', marketing: 'revoked' })
  })
})

describe('recordConsent', () => {
  it('inserts whatsapp events with evidence and no message content', async () => {
    const { db, inserts } = fakeDb({})
    await recordConsent(
      [
        { accountId: A, contactId: C, purpose: 'marketing', status: 'revoked', source: 'inbound', evidence: 'wamid.X' },
        { accountId: A, contactId: C, purpose: 'service', status: 'revoked', source: 'inbound', evidence: 'wamid.X' },
      ],
      db,
    )
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('contact_consents')
    expect(inserts[0].rows).toEqual([
      { account_id: A, contact_id: C, channel: 'whatsapp', purpose: 'marketing', status: 'revoked', source: 'inbound', evidence: 'wamid.X', recorded_by: null },
      { account_id: A, contact_id: C, channel: 'whatsapp', purpose: 'service', status: 'revoked', source: 'inbound', evidence: 'wamid.X', recorded_by: null },
    ])
  })

  it('accepts a QR source code', async () => {
    const { db, inserts } = fakeDb({})
    await recordConsent({ accountId: A, contactId: C, purpose: 'service', status: 'granted', source: 'OL-TZ-BF1' }, db)
    expect(inserts[0].rows[0].source).toBe('OL-TZ-BF1')
  })

  it.each([
    [{ purpose: 'promo' }, /purpose/],
    [{ status: 'maybe' }, /status/],
    [{ source: 'qr' }, /source/],
    [{ source: 'OL-tz-bf1' }, /source/],
    [{ evidence: 'x'.repeat(201) }, /evidence/],
    [{ contactId: '' }, /required/],
  ])('rejects invalid input %j', async (patch, msg) => {
    const { db, inserts } = fakeDb({})
    await expect(
      recordConsent(
        { accountId: A, contactId: C, purpose: 'service', status: 'granted', source: 'inbound', ...(patch as object) } as never,
        db,
      ),
    ).rejects.toThrow(msg)
    expect(inserts).toHaveLength(0)
  })

  it('throws ConsentError when the insert fails', async () => {
    const { db } = fakeDb({}, { failOn: 'contact_consents' })
    await expect(
      recordConsent({ accountId: A, contactId: C, purpose: 'service', status: 'granted', source: 'inbound' }, db),
    ).rejects.toBeInstanceOf(ConsentError)
  })

  it('is a no-op for an empty list', async () => {
    const { db, inserts } = fakeDb({})
    await recordConsent([], db)
    expect(inserts).toHaveLength(0)
  })
})

describe('batch guards', () => {
  it('blockedContactIds returns only revoked contacts of the account', async () => {
    const { db } = fakeDb({
      contact_consent_current: [
        { account_id: A, contact_id: 'c1', channel: 'whatsapp', purpose: 'marketing', status: 'revoked' },
        { account_id: A, contact_id: 'c2', channel: 'whatsapp', purpose: 'service', status: 'granted' },
        { account_id: 'acc-2', contact_id: 'c3', channel: 'whatsapp', purpose: 'service', status: 'revoked' },
      ],
    })
    expect([...(await blockedContactIds(A, ['c1', 'c2', 'c3', 'c1'], db))]).toEqual(['c1'])
  })

  it('blockedContactIds chunks large lists', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `c${i}`)
    const { db } = fakeDb({
      contact_consent_current: [
        { account_id: A, contact_id: 'c0', channel: 'whatsapp', purpose: 'service', status: 'revoked' },
        { account_id: A, contact_id: 'c449', channel: 'whatsapp', purpose: 'service', status: 'revoked' },
      ],
    })
    expect([...(await blockedContactIds(A, ids, db))].sort()).toEqual(['c0', 'c449'])
  })

  it('blockedContactIds throws on lookup error (caller fails closed)', async () => {
    const { db } = fakeDb({}, { failOn: 'contact_consent_current' })
    await expect(blockedContactIds(A, ['c1'], db)).rejects.toBeInstanceOf(ConsentError)
  })

  it('blockedPhones maps phones → contacts → revoked state', async () => {
    const { db } = fakeDb({
      contacts: [
        { id: 'c1', account_id: A, phone_normalized: '15555550101' },
        { id: 'c2', account_id: A, phone_normalized: '15555550102' },
        { id: 'c9', account_id: 'acc-2', phone_normalized: '15555550102' },
      ],
      contact_consent_current: [
        { account_id: A, contact_id: 'c1', channel: 'whatsapp', purpose: 'service', status: 'revoked' },
        { account_id: 'acc-2', contact_id: 'c9', channel: 'whatsapp', purpose: 'service', status: 'revoked' },
      ],
    })
    const out = await blockedPhones(A, ['+1 555 555 0101', '+15555550102', '+15555550103'], db)
    expect([...out]).toEqual(['15555550101'])
  })

  it('blockedPhones returns empty when no contact matches', async () => {
    const { db } = fakeDb({ contacts: [] })
    expect((await blockedPhones(A, ['+15555550103'], db)).size).toBe(0)
  })
})
