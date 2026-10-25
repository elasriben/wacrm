import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.ack' })),
  state: {
    /** Rows of contact_consent_current for the contact. */
    current: [] as { purpose: string; status: string }[],
    currentError: null as { message: string } | null,
    insertError: null as { message: string } | null,
    consentInserts: [] as Record<string, unknown>[][],
    messageInserts: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTextMessage: h.sendTextMessage }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/oralink/admin-client', () => ({ supabaseAdmin: () => ({}) }))

import { handleInboundOptKeyword, START_ACK_TEXT, STOP_ACK_TEXT } from './opt-keyword'

function fakeDb() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b
      b.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table === 'contact_consents') {
          h.state.consentInserts.push(rows as Record<string, unknown>[])
          return Promise.resolve({ error: h.state.insertError })
        }
        if (table === 'messages') h.state.messageInserts.push(rows as Record<string, unknown>)
        return Promise.resolve({ error: null })
      }
      b.maybeSingle = async () =>
        table === 'contacts'
          ? { data: { id: 'ct-1', phone: '15555550120', wa_user_id: null }, error: null }
          : { data: null, error: null }
      b.single = async () =>
        table === 'whatsapp_config'
          ? { data: { phone_number_id: 'pn-1', access_token: 'tok' }, error: null }
          : { data: null, error: null }
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          table === 'contact_consent_current'
            ? { data: h.state.currentError ? null : h.state.current, error: h.state.currentError }
            : { data: null, error: null },
        ).then(res)
      return b
    },
  }
}

const INPUT = {
  accountId: 'acc-1',
  contactId: 'ct-1',
  conversationId: 'cv-1',
  wamid: 'wamid.IN1',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.current = []
  h.state.currentError = null
  h.state.insertError = null
  h.state.consentInserts = []
  h.state.messageInserts = []
})

describe('handleInboundOptKeyword — STOP', () => {
  it('revokes service AND marketing with the wamid as evidence, then acknowledges once', async () => {
    const r = await handleInboundOptKeyword({ ...INPUT, keyword: 'stop' }, fakeDb() as never)
    expect(r).toEqual({ handled: true, recorded: true, acknowledged: true })
    expect(h.state.consentInserts).toHaveLength(1)
    const rows = h.state.consentInserts[0]
    expect(rows.map((x) => [x.purpose, x.status, x.source])).toEqual([
      ['service', 'revoked', 'inbound'],
      ['marketing', 'revoked', 'inbound'],
    ])
    expect(rows.every((x) => x.evidence === 'wamid:wamid.IN1' && x.account_id === 'acc-1')).toBe(true)
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1)
    expect(h.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '15555550120', text: STOP_ACK_TEXT }),
    )
    expect(h.state.messageInserts).toEqual([
      expect.objectContaining({ conversation_id: 'cv-1', sender_type: 'bot', content_text: STOP_ACK_TEXT }),
    ])
  })

  it('a repeated STOP is journaled but not re-acknowledged', async () => {
    h.state.current = [
      { purpose: 'service', status: 'revoked' },
      { purpose: 'marketing', status: 'revoked' },
    ]
    const r = await handleInboundOptKeyword({ ...INPUT, keyword: 'stop' }, fakeDb() as never)
    expect(r).toEqual({ handled: true, recorded: true, acknowledged: false })
    expect(h.state.consentInserts).toHaveLength(1)
    expect(h.sendTextMessage).not.toHaveBeenCalled()
  })

  it('still records the revocation when the state lookup fails', async () => {
    h.state.currentError = { message: 'db down' }
    const r = await handleInboundOptKeyword({ ...INPUT, keyword: 'stop' }, fakeDb() as never)
    expect(r.recorded).toBe(true)
    expect(r.handled).toBe(true)
  })

  it('does not acknowledge an opt-out that could not be recorded, but keeps the bots silent', async () => {
    h.state.insertError = { message: 'insert failed' }
    const r = await handleInboundOptKeyword({ ...INPUT, keyword: 'stop' }, fakeDb() as never)
    expect(r).toEqual({ handled: true, recorded: false, acknowledged: false })
    expect(h.sendTextMessage).not.toHaveBeenCalled()
  })

  it('never throws when the acknowledgement fails', async () => {
    h.sendTextMessage.mockRejectedValueOnce(new Error('meta down'))
    const r = await handleInboundOptKeyword({ ...INPUT, keyword: 'stop' }, fakeDb() as never)
    expect(r).toEqual({ handled: true, recorded: true, acknowledged: false })
  })
})

describe('handleInboundOptKeyword — START ❓', () => {
  it('re-grants only the revoked purposes of an opted-out contact and acknowledges', async () => {
    h.state.current = [
      { purpose: 'service', status: 'revoked' },
      { purpose: 'marketing', status: 'revoked' },
    ]
    const r = await handleInboundOptKeyword({ ...INPUT, keyword: 'start' }, fakeDb() as never)
    expect(r).toEqual({ handled: true, recorded: true, acknowledged: true })
    expect(h.state.consentInserts[0].map((x) => [x.purpose, x.status])).toEqual([
      ['service', 'granted'],
      ['marketing', 'granted'],
    ])
    expect(h.sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ text: START_ACK_TEXT }))
  })

  it('is NOT a consent event for a contact who never opted out (no inferred consent)', async () => {
    const r = await handleInboundOptKeyword({ ...INPUT, keyword: 'start' }, fakeDb() as never)
    expect(r).toEqual({ handled: false, recorded: false, acknowledged: false })
    expect(h.state.consentInserts).toHaveLength(0)
    expect(h.sendTextMessage).not.toHaveBeenCalled()
  })

  it('does nothing when the state cannot be read', async () => {
    h.state.currentError = { message: 'db down' }
    const r = await handleInboundOptKeyword({ ...INPUT, keyword: 'start' }, fakeDb() as never)
    expect(r.handled).toBe(false)
    expect(h.state.consentInserts).toHaveLength(0)
  })
})
