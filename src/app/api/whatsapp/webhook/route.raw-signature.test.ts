/**
 * Webhook POST with the REAL HMAC verification (no mock of
 * webhook-signature): the signature must cover the exact request bytes,
 * and every rejection must happen before any database access, any
 * after() processing and any automated reply.
 *
 * Secret and identifiers are visibly fake; no network call is made.
 */
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET = 'ci-dummy-webhook-secret'

const h = vi.hoisted(() => ({
  fromCalls: [] as string[],
  rpcCalls: [] as string[],
  messageUpserts: [] as Record<string, unknown>[],
  afterCallbacks: [] as (() => Promise<void> | void)[],
  dispatchInboundToFlows: vi.fn(),
  runAutomationsForTrigger: vi.fn(),
  resumeAwaitingReply: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  handleInboundOptKeyword: vi.fn(),
  sendTextMessage: vi.fn(),
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}))

// Generic chainable fake: records every table touched. Rejections must
// leave `fromCalls` empty.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      h.fromCalls.push(table)
      const ops: string[] = []
      let upsertRow: Record<string, unknown> | null = null
      const result = () => {
        switch (table) {
          case 'whatsapp_config':
            return {
              data: [{ account_id: 'acc-1', user_id: 'user-1', access_token: 'enc', mirror_inbound_media: false }],
              error: null,
            }
          case 'conversations':
            return ops.includes('update')
              ? { data: [], error: null }
              : { data: [{ id: 'conv-1', unread_count: 0, account_id: 'acc-1', status: 'open' }], error: null }
          case 'messages':
            if (upsertRow) {
              h.messageUpserts.push(upsertRow)
              return { data: [{ id: 'msg-1' }], error: null }
            }
            return { data: null, error: null }
          default:
            return { data: null, error: null }
        }
      }
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'insert', 'neq', 'gt']) {
        b[m] = () => {
          ops.push(m)
          return b
        }
      }
      b.upsert = (row: Record<string, unknown>) => {
        upsertRow = row
        return b
      }
      b.maybeSingle = async () => ({ data: null, error: null })
      b.single = async () => result()
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(res, rej)
      return b
    },
    rpc: (name: string) => {
      h.rpcCalls.push(name)
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  sendTextMessage: h.sendTextMessage,
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({ id: 'contact-1', name: 'Test', phone: '15555550100' })),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
  resumeAwaitingReply: h.resumeAwaitingReply,
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchInboundToFlows }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.dispatchInboundToAiReply }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatchWebhookEvent }))
vi.mock('@/lib/whatsapp/message-status-sync', () => ({ applyMessageStatus: vi.fn(async () => []) }))
vi.mock('@/lib/oralink/opt-keyword', () => ({ handleInboundOptKeyword: h.handleInboundOptKeyword }))

import { POST } from './route'
import { MAX_WEBHOOK_BODY_BYTES } from '@/lib/whatsapp/webhook-body'

type Res = { body: unknown; status: number }

function sign(bytes: Buffer, secret = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(bytes).digest('hex')
}

function textEnvelope(text: string, id = 'wamid.RAW1'): string {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts: [{ wa_id: '15555550100', profile: { name: 'Test' } }],
              messages: [
                { id, from: '15555550100', timestamp: '1700000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  })
}

async function post(bytes: Buffer, signature: string | null): Promise<Res> {
  const headers: Record<string, string> = {}
  if (signature !== null) headers['x-hub-signature-256'] = signature
  const res = (await POST(
    new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers,
      body: new Uint8Array(bytes),
    }),
  )) as unknown as Res
  for (const cb of h.afterCallbacks) await cb()
  return res
}

/** A valid JSON envelope whose text body holds one raw (invalid UTF-8) byte. */
function envelopeWithRawByte(byte: number): Buffer {
  const [before, after] = textEnvelope('X').split('"X"')
  return Buffer.concat([Buffer.from(before + '"a'), Buffer.from([byte]), Buffer.from('b"' + after)])
}

function expectNothingProcessed() {
  expect(h.afterCallbacks).toHaveLength(0)
  expect(h.fromCalls).toEqual([])
  expect(h.rpcCalls).toEqual([])
  expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
  expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
  expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  expect(h.handleInboundOptKeyword).not.toHaveBeenCalled()
  expect(h.sendTextMessage).not.toHaveBeenCalled()
}

let warn: { mockRestore: () => void }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('META_APP_SECRET', SECRET)
  h.fromCalls = []
  h.rpcCalls = []
  h.messageUpserts = []
  h.afterCallbacks = []
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.resumeAwaitingReply.mockResolvedValue(false)
  h.runAutomationsForTrigger.mockResolvedValue(undefined)
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.handleInboundOptKeyword.mockResolvedValue({ handled: true, recorded: true, acknowledged: true })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  vi.unstubAllEnvs()
})

describe('webhook HMAC over raw bytes — rejections (nothing processed)', () => {
  it('N3a: one byte changed after signing → 401', async () => {
    const signed = Buffer.from(textEnvelope('bonjour'))
    const sig = sign(signed)
    const tampered = Buffer.from(signed)
    tampered[tampered.indexOf('b'.charCodeAt(0), tampered.indexOf('bonjour'))] = 'B'.charCodeAt(0)
    expect((await post(tampered, sig)).status).toBe(401)
    expectNothingProcessed()
  })

  it('N3b: body with 0xFF signed as 0xFE (same lossy string) → 401', async () => {
    const received = envelopeWithRawByte(0xff)
    const signedVariant = envelopeWithRawByte(0xfe)
    // Precondition: both bodies decode to the SAME lenient UTF-8 string.
    expect(received.toString('utf8')).toBe(signedVariant.toString('utf8'))
    expect((await post(received, sign(signedVariant))).status).toBe(401)
    expectNothingProcessed()
  })

  it('N3c: signature over the re-encoded string instead of the received bytes → 401', async () => {
    const received = envelopeWithRawByte(0xff)
    const reencoded = Buffer.from(received.toString('utf8'), 'utf8')
    expect(reencoded.equals(received)).toBe(false)
    expect((await post(received, sign(reencoded))).status).toBe(401)
    expectNothingProcessed()
  })

  it('N3d: missing header → 401', async () => {
    expect((await post(Buffer.from(textEnvelope('bonjour')), null)).status).toBe(401)
    expectNothingProcessed()
  })

  it('N3d: sha1= header → 401', async () => {
    const bytes = Buffer.from(textEnvelope('bonjour'))
    const sha1 = 'sha1=' + crypto.createHmac('sha1', SECRET).update(bytes).digest('hex')
    expect((await post(bytes, sha1)).status).toBe(401)
    expectNothingProcessed()
  })

  it('valid signature but invalid UTF-8 → 400, nothing processed', async () => {
    const bytes = envelopeWithRawByte(0xff)
    const res = await post(bytes, sign(bytes))
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid UTF-8' })
    expectNothingProcessed()
  })

  it('valid signature but invalid JSON → 400, nothing processed', async () => {
    const bytes = Buffer.from('{"entry": [', 'utf8')
    const res = await post(bytes, sign(bytes))
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid JSON' })
    expectNothingProcessed()
  })

  it('body over 4 MiB → 413 before signature verification (even without a header)', async () => {
    const big = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1, 0x20)
    expect((await post(big, null)).status).toBe(413)
    expect((await post(big, sign(big))).status).toBe(413)
    expectNothingProcessed()
  })
})

describe('webhook HMAC over raw bytes — positive controls (P1)', () => {
  it.each([
    ['français (accents)', 'Bonjour, je voudrais réserver un séjour à Agadir — merci ! Ça coûte combien ?'],
    ['arabe', 'مرحبا، أريد معلومات عن الأسعار من فضلك'],
    ['darija', 'سلام، بغيت نعرف الثمن ديال الكراء عافاك'],
  ])('%s: signed UTF-8 message → 200, text decoded identically', async (_label, text) => {
    const bytes = Buffer.from(textEnvelope(text), 'utf8')
    const res = await post(bytes, sign(bytes))
    expect(res.status).toBe(200)
    expect(h.messageUpserts).toHaveLength(1)
    expect(h.messageUpserts[0].content_text).toBe(text)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ kind: 'text', text }) }),
    )
    expect(h.handleInboundOptKeyword).not.toHaveBeenCalled()
  })

  it('a signed darija STOP (❓ keyword list) is detected as an opt-out', async () => {
    const bytes = Buffer.from(textEnvelope('توقف', 'wamid.RAWSTOP'), 'utf8')
    const res = await post(bytes, sign(bytes))
    expect(res.status).toBe(200)
    expect(h.handleInboundOptKeyword).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: 'stop', wamid: 'wamid.RAWSTOP', accountId: 'acc-1' }),
    )
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })
})
