/**
 * Every automated outbound path listed in docs/oralink/crm/audit-consentement.md §2
 * must go through the REAL consent guard and send nothing to Meta for a
 * contact whose latest consent event is `revoked` (STOP).
 *
 * The consent module is NOT mocked: each sender's own service-role client is
 * replaced by a fake database in which the contact has opted out, so the
 * test proves the wiring sender → canSendAutomated → contact_consent_current.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Op = { method: string; args: unknown[] }
  const state = {
    /** contact ids whose consent state is revoked (account acc-1). */
    revoked: new Set<string>(['ct-stop']),
    /** consent lookup error, to test fail-closed. */
    consentError: null as { message: string } | null,
    /** table → ops log. */
    calls: [] as { table: string; ops: Op[] }[],
    recipientUpdates: [] as { id: unknown; patch: Record<string, unknown> }[],
  }

  function resolveFor(table: string, ops: Op[]): { data: unknown; error: unknown; count?: number } {
    const eqs = ops.filter((o) => o.method === 'eq').map((o) => o.args)
    const ins = ops.find((o) => o.method === 'in')?.args
    const eqVal = (col: string) => eqs.find((a) => a[0] === col)?.[1]
    switch (table) {
      case 'contact_consent_current': {
        if (state.consentError) return { data: null, error: state.consentError }
        if (eqVal('account_id') !== 'acc-1') return { data: [], error: null }
        const ids = ins ? (ins[1] as string[]) : [eqVal('contact_id') as string]
        const rows = ids
          .filter((id) => state.revoked.has(id))
          .flatMap((id) => [
            { contact_id: id, purpose: 'service', status: 'revoked' },
            { contact_id: id, purpose: 'marketing', status: 'revoked' },
          ])
        return { data: rows, error: null }
      }
      case 'broadcasts':
        return { data: { account_id: 'acc-1' }, error: null }
      case 'broadcast_recipients': {
        const upd = ops.find((o) => o.method === 'update')
        if (upd) {
          state.recipientUpdates.push({ id: eqVal('id'), patch: upd.args[0] as Record<string, unknown> })
          return { data: null, error: null }
        }
        if (ins) {
          const map: Record<string, string> = { 'row-stop': 'ct-stop', 'row-ok': 'ct-ok' }
          return {
            data: (ins[1] as string[]).map((id) => ({ id, contact_id: map[id] ?? null })),
            error: null,
          }
        }
        return { data: null, error: null, count: 0 }
      }
      case 'contacts':
        // blockedPhones: phone_normalized → contact
        if (ins) {
          const byPhone: Record<string, string> = { '15555550110': 'ct-stop', '15555550111': 'ct-ok' }
          return {
            data: (ins[1] as string[])
              .filter((p) => byPhone[p])
              .map((p) => ({ id: byPhone[p], phone_normalized: p })),
            error: null,
          }
        }
        return { data: { id: 'ct-ok', phone: '15555550111', wa_user_id: null }, error: null }
      case 'whatsapp_config':
        return { data: { phone_number_id: 'pn-1', access_token: 'enc' }, error: null }
      case 'conversations':
        return { data: { id: 'cv-1', account_id: 'acc-1' }, error: null }
      default:
        return { data: null, error: null }
    }
  }

  function fakeDb() {
    return {
      from(table: string) {
        const ops: Op[] = []
        state.calls.push({ table, ops })
        const builder: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'update', 'insert', 'upsert', 'order', 'limit', 'is', 'neq', 'gt', 'lte']) {
          builder[m] = (...args: unknown[]) => {
            ops.push({ method: m, args })
            return builder
          }
        }
        builder.maybeSingle = async () => resolveFor(table, ops)
        builder.single = async () => resolveFor(table, ops)
        builder.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(resolveFor(table, ops)).then(res, rej)
        return builder
      },
      rpc: async () => ({ data: true, error: null }),
    }
  }

  return {
    state,
    fakeDb,
    meta: {
      sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.out' })),
      sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.out' })),
      sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.out' })),
      sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.out' })),
      sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.out' })),
      sendTypingIndicator: vi.fn(async () => undefined),
    },
    ai: {
      loadAiConfig: vi.fn(async () => ({ autoReplyEnabled: true, autoReplyMaxPerConversation: 5 })),
      generateReply: vi.fn(),
    },
    requireRole: vi.fn(),
  }
})

vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/meta-api')>()),
  ...h.meta,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.fakeDb() }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.fakeDb() }))
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => h.fakeDb() }))
vi.mock('@/lib/oralink/admin-client', () => ({ supabaseAdmin: () => h.fakeDb() }))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: h.ai.loadAiConfig }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: h.ai.generateReply }))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: unknown) => ({ status: 500, body: String(e) }),
}))
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true }),
}))

import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText as flowSendText,
} from '@/lib/flows/meta-send'
import {
  engineSendInteractive,
  engineSendTemplate,
  engineSendText as automationSendText,
} from '@/lib/automations/meta-send'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { deliverBroadcast, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core'
import { POST as broadcastPOST } from '@/app/api/whatsapp/broadcast/route'
import { ConsentBlockedError } from './consent'
import { BROADCAST_OPT_OUT_ERROR } from './broadcast-guard'

const BASE = { accountId: 'acc-1', userId: 'u-1', conversationId: 'cv-1' }
const STOP = { ...BASE, contactId: 'ct-stop' }

function metaCalls(): number {
  return Object.values(h.meta).reduce((n, fn) => n + fn.mock.calls.length, 0)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.revoked = new Set(['ct-stop'])
  h.state.consentError = null
  h.state.calls = []
  h.state.recipientUpdates = []
})

describe('flows senders (flows/meta-send.ts) — also used by the AI reply', () => {
  it('engineSendText refuses an opted-out contact before any Meta call', async () => {
    await expect(flowSendText({ ...STOP, text: 'hi' })).rejects.toBeInstanceOf(ConsentBlockedError)
    expect(metaCalls()).toBe(0)
  })

  it('engineSendMedia refuses an opted-out contact', async () => {
    await expect(
      engineSendMedia({ ...STOP, kind: 'image', link: 'https://example.test/a.jpg' }),
    ).rejects.toBeInstanceOf(ConsentBlockedError)
    expect(metaCalls()).toBe(0)
  })

  it('engineSendInteractiveButtons / List refuse an opted-out contact', async () => {
    const buttons = { kind: 'buttons', body: 'b', buttons: [{ id: 'x', title: 'X' }] }
    const list = {
      kind: 'list',
      body: 'b',
      button_text: 'Voir',
      sections: [{ title: 's', rows: [{ id: 'r', title: 'R' }] }],
    }
    await expect(
      engineSendInteractiveButtons({ ...STOP, payload: buttons } as never),
    ).rejects.toBeInstanceOf(ConsentBlockedError)
    await expect(
      engineSendInteractiveList({ ...STOP, payload: list } as never),
    ).rejects.toBeInstanceOf(ConsentBlockedError)
    expect(metaCalls()).toBe(0)
  })

  it('fails closed when the consent lookup errors', async () => {
    h.state.consentError = { message: 'db down' }
    await expect(
      flowSendText({ ...BASE, contactId: 'ct-ok', text: 'hi' }),
    ).rejects.toBeInstanceOf(ConsentBlockedError)
    expect(metaCalls()).toBe(0)
  })
})

describe('automation senders (automations/meta-send.ts)', () => {
  it('engineSendText refuses an opted-out contact', async () => {
    await expect(automationSendText({ ...STOP, text: 'hi' })).rejects.toBeInstanceOf(ConsentBlockedError)
    expect(metaCalls()).toBe(0)
  })

  it('engineSendTemplate refuses an opted-out contact', async () => {
    await expect(
      engineSendTemplate({ ...STOP, templateName: 'promo', language: 'fr', params: [] }),
    ).rejects.toBeInstanceOf(ConsentBlockedError)
    expect(metaCalls()).toBe(0)
  })

  it('engineSendInteractive refuses an opted-out contact', async () => {
    await expect(
      engineSendInteractive({
        ...STOP,
        payload: { kind: 'buttons', body: 'b', buttons: [{ id: 'x', title: 'X' }] },
      } as never),
    ).rejects.toBeInstanceOf(ConsentBlockedError)
    expect(metaCalls()).toBe(0)
  })
})

describe('AI auto-reply (ai/auto-reply.ts)', () => {
  it('stands down for an opted-out contact: no typing indicator, no LLM call, no send', async () => {
    await dispatchInboundToAiReply({
      accountId: 'acc-1',
      conversationId: 'cv-1',
      contactId: 'ct-stop',
      configOwnerUserId: 'u-1',
      inboundMessageId: 'wamid.in',
    })
    expect(h.ai.loadAiConfig).toHaveBeenCalled()
    expect(h.ai.generateReply).not.toHaveBeenCalled()
    expect(metaCalls()).toBe(0)
  })
})

describe('broadcast fan-out (broadcast-core.ts deliverBroadcast — API v1 + resume)', () => {
  const plan: BroadcastPlan = {
    broadcastId: 'bc-1',
    templateName: 'promo',
    templateLanguage: 'fr',
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
    templateRow: null,
    planned: [
      { recipientRowId: 'row-stop', phone: '15555550110', params: [] },
      { recipientRowId: 'row-ok', phone: '15555550111', params: [] },
    ],
    rejected: 0,
  }

  it('skips the opted-out recipient (marked failed) and sends to the others', async () => {
    await deliverBroadcast(h.fakeDb() as never, plan)
    expect(h.meta.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(h.meta.sendTemplateMessage.mock.calls[0]).toEqual([
      expect.objectContaining({ to: '15555550111' }),
    ])
    expect(h.state.recipientUpdates).toContainEqual({
      id: 'row-stop',
      patch: { status: 'failed', error_message: BROADCAST_OPT_OUT_ERROR },
    })
  })

  it('fails closed: a consent lookup error sends nothing', async () => {
    h.state.consentError = { message: 'db down' }
    await deliverBroadcast(h.fakeDb() as never, plan)
    expect(h.meta.sendTemplateMessage).not.toHaveBeenCalled()
    expect(h.state.recipientUpdates.map((u) => u.patch.status)).toEqual(['failed', 'failed'])
  })
})

describe('dashboard broadcast route (api/whatsapp/broadcast POST)', () => {
  function post(phones: string[]) {
    return broadcastPOST(
      new Request('http://localhost/api/whatsapp/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: phones.map((phone) => ({ phone, params: [] })),
          template_name: 'promo',
          template_language: 'fr',
        }),
      }),
    ) as Promise<{ status?: number; json: () => Promise<Record<string, unknown>> }>
  }

  beforeEach(() => {
    h.requireRole.mockResolvedValue({ supabase: h.fakeDb(), accountId: 'acc-1', userId: 'u-1' })
  })

  it('does not send to an opted-out phone, sends to the others', async () => {
    const res = await post(['+15555550110', '+15555550111'])
    const body = await res.json()
    expect(h.meta.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(h.meta.sendTemplateMessage.mock.calls[0]).toEqual([
      expect.objectContaining({ to: '15555550111' }),
    ])
    expect(body.results).toContainEqual({
      phone: '+15555550110',
      status: 'failed',
      error: BROADCAST_OPT_OUT_ERROR,
    })
  })

  it('refuses the whole batch (503) when the consent lookup fails', async () => {
    h.state.consentError = { message: 'db down' }
    const res = await post(['+15555550111'])
    expect(res.status).toBe(503)
    expect(h.meta.sendTemplateMessage).not.toHaveBeenCalled()
  })
})
