import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OraLink QUALITÉ — security tests for the WhatsApp webhook (current code, read-only).
 *
 * Unlike route.test.ts, which stubs `verifyMetaWebhookSignature` to `true`,
 * these tests run the REAL signature check (`@/lib/whatsapp/webhook-signature`),
 * the REAL body cap (`@/lib/whatsapp/webhook-body`) and the REAL encryption of
 * verify tokens, end to end through the route handlers. Only the database
 * client, `next/server` and the outbound engines are replaced, so that we can
 * observe whether anything touched the database or scheduled processing.
 *
 * All secrets below are visibly fake (`ci-dummy-…`).
 */

const h = vi.hoisted(() => ({
  state: {
    /** Tables passed to supabase `.from()`, in order. Any entry = DB access. */
    fromCalls: [] as string[],
    /** Callbacks the route handed to `after()` (= scheduled processing). */
    afterCallbacks: [] as (() => Promise<void> | void)[],
    /** What an awaited query on a table resolves to. */
    tableResult: (() => ({ data: [], error: null })) as (table: string) => unknown,
    /** When set, `.from()` throws this (simulates a client crash). */
    fromThrows: null as Error | null,
  },
  engines: {
    runAutomationsForTrigger: vi.fn(),
    resumeAwaitingReply: vi.fn(),
    dispatchInboundToFlows: vi.fn(),
    dispatchInboundToAiReply: vi.fn(),
    dispatchWebhookEvent: vi.fn(),
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}))

// Chainable, awaitable stand-in for any supabase query builder.
function query(table: string): unknown {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') {
        const result = h.state.tableResult(table)
        return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
          Promise.resolve(result).then(ok, ko)
      }
      return () => query(table)
    },
  })
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      h.state.fromCalls.push(table)
      if (h.state.fromThrows) throw h.state.fromThrows
      return query(table)
    },
  }),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.engines.runAutomationsForTrigger,
  resumeAwaitingReply: h.engines.resumeAwaitingReply,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.engines.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.engines.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.engines.dispatchWebhookEvent,
}))

import { GET, POST } from './route'
import { encrypt } from '@/lib/whatsapp/encryption'
import { MAX_WEBHOOK_BODY_BYTES } from '@/lib/whatsapp/webhook-body'

const SECRET_A = 'ci-dummy-app-secret-A'
const SECRET_B = 'ci-dummy-app-secret-B'
const SECRET_OTHER = 'ci-dummy-app-secret-not-configured'
const URL_WEBHOOK = 'http://localhost/api/whatsapp/webhook'
/** Marker placed in bodies to detect it being echoed back or logged. */
const BODY_MARKER = 'ci-dummy-private-message-content'

const INBOUND_BODY = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '000', phone_number_id: 'pn-ci-dummy' },
            contacts: [{ wa_id: '000000000000', profile: { name: 'CI' } }],
            messages: [
              {
                id: 'wamid.CI',
                from: '000000000000',
                timestamp: '1700000000',
                type: 'text',
                text: { body: BODY_MARKER },
              },
            ],
          },
        },
      ],
    },
  ],
})

function sign(body: string | Uint8Array, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function post(body: BodyInit | null, signature?: string | string[], extra: Record<string, string> = {}) {
  const headers = new Headers(extra)
  for (const s of signature === undefined ? [] : Array.isArray(signature) ? signature : [signature]) {
    headers.append('x-hub-signature-256', s)
  }
  return new Request(URL_WEBHOOK, { method: 'POST', headers, body })
}

async function json(res: Response) {
  return JSON.parse(await res.text()) as Record<string, unknown>
}

let logSpies: ReturnType<typeof vi.spyOn>[] = []
function loggedText(): string {
  return logSpies
    .flatMap((s) => s.mock.calls.flat())
    .map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a)))
    .join('\n')
}

beforeEach(() => {
  h.state.fromCalls = []
  h.state.afterCallbacks = []
  h.state.tableResult = () => ({ data: [], error: null })
  h.state.fromThrows = null
  vi.stubEnv('META_APP_SECRET', `${SECRET_A}, ${SECRET_B}`)
  logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function expectNothingHappened() {
  expect(h.state.fromCalls).toEqual([])
  expect(h.state.afterCallbacks).toHaveLength(0)
  for (const fn of Object.values(h.engines)) expect(fn).not.toHaveBeenCalled()
}

describe('POST signature: rejected before any database access or processing', () => {
  it('missing x-hub-signature-256 header -> 401', async () => {
    const res = await POST(post(INBOUND_BODY))
    expect(res.status).toBe(401)
    expect(await json(res)).toEqual({ error: 'Invalid signature' })
    expectNothingHappened()
  })

  const valid = () => sign(INBOUND_BODY, SECRET_A)
  it.each([
    ['empty value', () => ''],
    ['prefix only', () => 'sha256='],
    ['no prefix, bare hex of a valid HMAC', () => valid().slice('sha256='.length)],
    ['sha1= prefix with a valid sha256 hex', () => 'sha1=' + valid().slice('sha256='.length)],
    ['valid HMAC truncated by one char', () => valid().slice(0, -1)],
    ['valid HMAC plus one extra char', () => valid() + '0'],
    ['right length, not hex', () => 'sha256=' + 'z'.repeat(64)],
    ['all zeros', () => 'sha256=' + '0'.repeat(64)],
    ['base64 instead of hex', () => 'sha256=' + crypto.createHmac('sha256', SECRET_A).update(INBOUND_BODY).digest('base64')],
  ])('malformed signature (%s) -> 401', async (_label, make) => {
    const res = await POST(post(INBOUND_BODY, make()))
    expect(res.status).toBe(401)
    expectNothingHappened()
  })

  it('signature from a secret that is not configured -> 401', async () => {
    const res = await POST(post(INBOUND_BODY, sign(INBOUND_BODY, SECRET_OTHER)))
    expect(res.status).toBe(401)
    expectNothingHappened()
  })

  it('valid signature for a different body (tampered payload) -> 401', async () => {
    const tampered = INBOUND_BODY.replace('pn-ci-dummy', 'pn-ci-other')
    const res = await POST(post(tampered, sign(INBOUND_BODY, SECRET_A)))
    expect(res.status).toBe(401)
    expectNothingHappened()
  })

  it('a valid header duplicated with a forged one is not accepted (no header smuggling)', async () => {
    // Fetch Headers joins duplicates as "v1, v2": the combined value matches no HMAC.
    const res = await POST(post(INBOUND_BODY, [sign(INBOUND_BODY, SECRET_A), 'sha256=' + '0'.repeat(64)]))
    expect(res.status).toBe(401)
    expectNothingHappened()
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only commas and spaces', ' , ,'],
  ])('META_APP_SECRET %s -> fail closed, even with an HMAC keyed by the empty string', async (_l, value) => {
    vi.stubEnv('META_APP_SECRET', value as string)
    const res = await POST(post(INBOUND_BODY, sign(INBOUND_BODY, '')))
    expect(res.status).toBe(401)
    expectNothingHappened()
  })

  it('invalid JSON is rejected AFTER the signature: an unsigned garbage body gets 401, not 400', async () => {
    const res = await POST(post('{not json'))
    expect(res.status).toBe(401)
    expectNothingHappened()
  })
})

describe('POST signature: accepted with multi-value META_APP_SECRET', () => {
  it.each([
    ['first secret', SECRET_A],
    ['second secret (after comma and space)', SECRET_B],
  ])('signed with the %s -> 200 and processing is scheduled', async (_l, secret) => {
    const res = await POST(post(INBOUND_BODY, sign(INBOUND_BODY, secret)))
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ status: 'received' })
    expect(h.state.afterCallbacks).toHaveLength(1)
    // The ack itself does not touch the database: work happens in after().
    expect(h.state.fromCalls).toEqual([])
  })

  it('control: the database spy does see access once a signed payload is processed', async () => {
    await POST(post(INBOUND_BODY, sign(INBOUND_BODY, SECRET_B)))
    for (const cb of h.state.afterCallbacks) await cb()
    expect(h.state.fromCalls).toContain('whatsapp_config')
  })

  it('a UTF-8 multibyte body (Arabic / darija) signed over its bytes is accepted', async () => {
    const body = JSON.stringify({ entry: [], note: 'توقف ستوب' })
    const res = await POST(post(body, sign(Buffer.from(body, 'utf8'), SECRET_A)))
    expect(res.status).toBe(200)
  })

  it('invalid UTF-8 bytes signed over the raw bytes are rejected (fails closed: false reject, never an acceptance)', async () => {
    // readCappedBody decodes to a string (U+FFFD replacement) before the HMAC,
    // so the HMAC is not over the exact bytes received. Effect: a false reject,
    // never an acceptance. Meta always sends valid UTF-8 JSON.
    const raw = Buffer.concat([Buffer.from('{"entry":[],"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])
    const res = await POST(post(raw, sign(raw, SECRET_A)))
    expect(res.status).toBe(401)
    expectNothingHappened()
  })
})

describe('POST signature: constant-time comparison', () => {
  // Reading webhook-signature.ts: each candidate is compared with
  // crypto.timingSafeEqual after an equal-length check (the expected length,
  // 71 bytes, is public), and the loop does not stop at the first match.
  it('every configured secret is compared with timingSafeEqual, even after a match', async () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    const res = await POST(post(INBOUND_BODY, sign(INBOUND_BODY, SECRET_A)))
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a same-length forged signature goes through timingSafeEqual for each secret', async () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    const res = await POST(post(INBOUND_BODY, 'sha256=' + 'a'.repeat(64)))
    expect(res.status).toBe(401)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a wrong-length signature is rejected without comparing contents (length is public)', async () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    const res = await POST(post(INBOUND_BODY, 'sha256=abc'))
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('POST body: non-JSON and oversized payloads', () => {
  it('validly signed non-JSON -> 400, nothing scheduled, no DB', async () => {
    const body = 'not-json ' + BODY_MARKER
    const res = await POST(post(body, sign(body, SECRET_A)))
    expect(res.status).toBe(400)
    const payload = await json(res)
    expect(payload).toEqual({ error: 'Invalid JSON' })
    expectNothingHappened()
  })

  it('validly signed empty body -> 400', async () => {
    const res = await POST(post('', sign('', SECRET_A)))
    expect(res.status).toBe(400)
    expectNothingHappened()
  })

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['entry as a string', '{"entry":"abc"}'],
    ['changes null', '{"entry":[{"changes":null}]}'],
  ])('validly signed JSON of the wrong shape (%s) -> 200 ack, processing errors are contained', async (_l, body) => {
    const res = await POST(post(body, sign(body, SECRET_A)))
    expect(res.status).toBe(200)
    for (const cb of h.state.afterCallbacks) await expect(Promise.resolve(cb())).resolves.toBeUndefined()
    for (const fn of Object.values(h.engines)) expect(fn).not.toHaveBeenCalled()
  })

  it('declared Content-Length over the cap -> 413 before signature or DB', async () => {
    const res = await POST(
      post('{}', sign('{}', SECRET_A), { 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) }),
    )
    expect(res.status).toBe(413)
    expectNothingHappened()
  })

  it('streamed body over the cap without Content-Length -> 413, even if validly signed', async () => {
    const big = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1)
    const chunk = new TextEncoder().encode(big)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk)
        c.close()
      },
    })
    const req = new Request(URL_WEBHOOK, {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(big, SECRET_A) },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect(req.headers.get('content-length')).toBeNull()
    const res = await POST(req)
    expect(res.status).toBe(413)
    expectNothingHappened()
  })
})

describe('POST errors do not leak data', () => {
  it('a rejected request does not echo the body, the presented or the expected signature, nor any secret', async () => {
    const presented = 'sha256=' + 'b'.repeat(64)
    const res = await POST(post(INBOUND_BODY, presented))
    const text = await res.text()
    const expected = sign(INBOUND_BODY, SECRET_A).slice(7)
    for (const needle of [BODY_MARKER, presented.slice(7), expected, SECRET_A, SECRET_B]) {
      expect(text).not.toContain(needle)
      expect(loggedText()).not.toContain(needle)
    }
    expect(res.headers.get('x-hub-signature-256')).toBeNull()
  })

  it('a processing crash after the ack is logged server-side only; the response is the bare ack', async () => {
    h.state.fromThrows = new Error('ci-dummy-internal-detail')
    const res = await POST(post(INBOUND_BODY, sign(INBOUND_BODY, SECRET_A)))
    expect(await res.text()).toBe(JSON.stringify({ status: 'received' }))
    for (const cb of h.state.afterCallbacks) await cb()
    expect(loggedText()).not.toContain(SECRET_A)
    expect(loggedText()).not.toContain(SECRET_B)
  })
})

describe('GET hub.verify_token handshake', () => {
  const TOKEN = 'ci-dummy-verify-token'
  const CHALLENGE = 'ci-dummy-challenge-1234'
  const get = (params: Record<string, string>) =>
    new Request(`${URL_WEBHOOK}?${new URLSearchParams(params).toString()}`, { method: 'GET' })
  const ok = { 'hub.mode': 'subscribe', 'hub.challenge': CHALLENGE, 'hub.verify_token': TOKEN }

  beforeEach(() => {
    h.state.tableResult = (table) =>
      table === 'whatsapp_config'
        ? {
            data: [
              { id: 'cfg-broken', verify_token: 'not-a-valid-ciphertext' },
              { id: 'cfg-null', verify_token: null },
              { id: 'cfg-1', verify_token: encrypt(TOKEN) },
            ],
            error: null,
          }
        : { data: [], error: null }
  })

  it('control: the right token returns the challenge as text/plain', async () => {
    const res = await GET(get(ok))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(await res.text()).toBe(CHALLENGE)
  })

  it.each([
    ['wrong token', 'ci-dummy-wrong-token'],
    ['prefix of the token', TOKEN.slice(0, -1)],
    ['token plus a suffix', TOKEN + 'x'],
    ['different case', TOKEN.toUpperCase()],
    ['the stored ciphertext itself', 'not-a-valid-ciphertext'],
  ])('%s -> 403, challenge not echoed', async (_l, token) => {
    const res = await GET(get({ ...ok, 'hub.verify_token': token }))
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).not.toContain(CHALLENGE)
    expect(text).not.toContain(TOKEN)
  })

  it.each([
    ['mode is not subscribe', { ...ok, 'hub.mode': 'unsubscribe' }],
    ['no challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN }],
    ['no token', { 'hub.mode': 'subscribe', 'hub.challenge': CHALLENGE }],
    ['empty token', { ...ok, 'hub.verify_token': '' }],
  ])('%s -> 400 without reading whatsapp_config', async (_l, params) => {
    const res = await GET(get(params as Record<string, string>))
    expect(res.status).toBe(400)
    expect(h.state.fromCalls).toEqual([])
  })

  it('no config row at all -> 403', async () => {
    h.state.tableResult = () => ({ data: [], error: null })
    const res = await GET(get(ok))
    expect(res.status).toBe(403)
  })

  it('database error -> 403 with a generic message (DB error not returned)', async () => {
    h.state.tableResult = () => ({ data: null, error: { message: 'ci-dummy-db-error-detail' } })
    const res = await GET(get(ok))
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).toBe(JSON.stringify({ error: 'Verification failed' }))
  })

  it('unexpected exception -> 500 with a generic message', async () => {
    h.state.fromThrows = new Error('ci-dummy-internal-detail')
    const res = await GET(get(ok))
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toBe(JSON.stringify({ error: 'Internal server error' }))
  })

  it('verify tokens are compared through timingSafeEqual (on SHA-256 digests)', async () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    await GET(get({ ...ok, 'hub.verify_token': 'ci-dummy-wrong-token' }))
    expect(spy).toHaveBeenCalled()
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32)
      expect((b as Buffer).length).toBe(32)
    }
  })
})
