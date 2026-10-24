// MAQUETTE (MOCK) — SendZen (voie Z′): waCRM's REAL inbound webhook handler, end to end, with no real
// service. SendZen is SIMULATED (oralink/sendzen-gateway/test/mock-sendzen.mjs): these tests prove what
// waCRM does with the payloads we EXPECT SendZen to send, not that SendZen sends them (T-S1…T-S12 ❓).
//
//   signed Meta-format webhook (as SendZen announces it) ──▶ REAL POST /api/whatsapp/webhook
//     ──▶ REAL signature check (META_APP_SECRET list) ──▶ REAL contact / conversation / message code
//     ──▶ REAL flows engine (keyword OL-TZ-BF1) ──▶ REAL flows meta-send ──▶ REAL meta-api.ts
//     ──▶ WHATSAPP_API_BASE_URL = REAL Z′ gateway (127.0.0.1:0) ──▶ MOCK SendZen (127.0.0.1:0)
//
// Replaced by test doubles: Supabase (an in-memory fake that enforces the unique indexes the
// behaviour depends on — migrations 022, 036, 037 and 010/017), `next/server`'s after() (drained
// explicitly), and the automations / AI auto-reply / public-webhook fan-out (spies; out of scope).
// What this CANNOT prove (real Postgres/RLS, real SendZen, real WhatsApp) is listed in
// docs/oralink/sendzen/contract.md (W-01…W-04).
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type DbError = { code: string; message: string } | null
type Result = { data: unknown; error: DbError; count?: number | null }

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  afterCallbacks: [] as (() => Promise<void> | void)[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  automations: [] as unknown[],
  aiReplies: [] as unknown[],
  publicEvents: [] as unknown[],
}))

// ---------------------------------------------------------------------------------------------------
// In-memory Supabase fake. Only the query-builder surface the exercised code paths use. Unique
// indexes are enforced because idempotence and race handling depend on them in production:
//   messages      (conversation_id, message_id)                       migration 037
//   contacts      (account_id, phone_normalized) WHERE <> ''          migration 022
//   conversations (account_id, contact_id)                            migration 036
//   flow_runs     (account_id, contact_id) WHERE status = 'active'     migrations 010 / 017
// ---------------------------------------------------------------------------------------------------
const UNIQUE: Record<string, { cols: string[]; where?: (r: Row) => boolean; name: string }[]> = {
  messages: [{ cols: ['conversation_id', 'message_id'], where: (r) => r.message_id != null, name: 'idx_messages_conversation_message_id' }],
  contacts: [{ cols: ['account_id', 'phone_normalized'], where: (r) => typeof r.phone_normalized === 'string' && r.phone_normalized !== '', name: 'idx_contacts_account_phone_normalized' }],
  conversations: [{ cols: ['account_id', 'contact_id'], name: 'idx_conversations_account_contact' }],
  flow_runs: [{ cols: ['account_id', 'contact_id'], where: (r) => r.status === 'active', name: 'idx_one_active_run_per_contact' }],
}
let idSeq = 0
let clock = Date.parse('2026-10-21T10:00:00Z')

function readColumn(row: Row, column: string): unknown {
  const [base, jsonKey] = column.split('->>')
  if (jsonKey === undefined) return row[base]
  return (row[base] as Row | null | undefined)?.[jsonKey] ?? null
}
function withDefaults(table: string, v: Row): Row {
  const now = new Date((clock += 1000)).toISOString()
  const row: Row = { id: `${table}-${++idSeq}`, created_at: now, ...v }
  if (table === 'contacts') row.phone_normalized = String(row.phone ?? '').replace(/\D/g, '')
  if (table === 'conversations') Object.assign(row, { status: 'open', unread_count: 0, first_inbound_at: null, ...v })
  if (table === 'flow_runs') Object.assign(row, { vars: {}, reprompt_count: 0, transition_seq: 0, started_at: now, ...v })
  return row
}
function conflicts(table: string, candidate: Row, rows: Row[]): string | null {
  for (const idx of UNIQUE[table] ?? []) {
    if (idx.where && !idx.where(candidate)) continue
    const hit = rows.some((r) => r !== candidate && (!idx.where || idx.where(r)) && idx.cols.every((c) => r[c] === candidate[c]))
    if (hit) return idx.name
  }
  return null
}
const uniqueError = (name: string): DbError => ({ code: '23505', message: `duplicate key value violates unique constraint "${name}"` })

function from(table: string) {
  const rows = (h.tables[table] ??= [])
  const filters: ((r: Row) => boolean)[] = []
  let op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select'
  let patch: Row = {}
  let pending: Row[] = []
  let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  let limit: number | null = null
  let order: { col: string; asc: boolean } | null = null
  let head = false

  const execute = (): Result => {
    if (op === 'insert' || op === 'upsert') {
      const out: Row[] = []
      for (const v of pending) {
        const row = withDefaults(table, v)
        const clash = conflicts(table, row, rows)
        if (clash) {
          if (op === 'upsert' && upsertOpts.ignoreDuplicates) continue // ON CONFLICT DO NOTHING
          return { data: null, error: uniqueError(clash) }
        }
        rows.push(row)
        out.push(structuredClone(row))
      }
      return { data: out, error: null }
    }
    const matched = rows.filter((r) => filters.every((f) => f(r)))
    if (op === 'update') {
      for (const r of matched) {
        const before = { ...r }
        Object.assign(r, structuredClone(patch))
        const clash = conflicts(table, r, rows)
        if (clash) { Object.assign(r, before); return { data: null, error: uniqueError(clash) } }
      }
      return { data: matched.map((r) => structuredClone(r)), error: null }
    }
    if (op === 'delete') {
      h.tables[table] = rows.filter((r) => !matched.includes(r))
      return { data: null, error: null }
    }
    let list = matched
    if (order) {
      const { col, asc } = order
      list = [...list].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1))
    }
    if (limit !== null) list = list.slice(0, limit)
    return { data: head ? null : list.map((r) => structuredClone(r)), error: null, count: matched.length }
  }

  const b = {
    select: (_cols?: string, opts?: { head?: boolean }) => { if (opts?.head) head = true; return b },
    eq: (c: string, v: unknown) => { filters.push((r) => readColumn(r, c) === v); return b },
    neq: (c: string, v: unknown) => { filters.push((r) => readColumn(r, c) !== v); return b },
    is: (c: string, v: unknown) => { filters.push((r) => (readColumn(r, c) ?? null) === v); return b },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(readColumn(r, c))); return b },
    filter: (c: string, operator: string, v: unknown) => { if (operator === 'eq') filters.push((r) => readColumn(r, c) === v); return b },
    order: (col: string, o?: { ascending?: boolean }) => { order = { col, asc: o?.ascending !== false }; return b },
    limit: (n: number) => { limit = n; return b },
    update: (v: Row) => { op = 'update'; patch = v; return b },
    delete: () => { op = 'delete'; return b },
    insert: (v: Row | Row[]) => { op = 'insert'; pending = Array.isArray(v) ? v : [v]; return b },
    upsert: (v: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => { op = 'upsert'; pending = Array.isArray(v) ? v : [v]; upsertOpts = o ?? {}; return b },
    maybeSingle: async (): Promise<Result> => {
      const r = execute()
      if (r.error) return r
      const list = (r.data as Row[] | null) ?? []
      if (list.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } }
      return { data: list[0] ?? null, error: null }
    },
    single: async (): Promise<Result> => {
      const r = execute()
      if (r.error) return r
      const list = (r.data as Row[] | null) ?? []
      if (list.length !== 1) return { data: null, error: { code: 'PGRST116', message: `expected 1 row, got ${list.length}` } }
      return { data: list[0], error: null }
    },
    then: (ok: (r: Result) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(execute).then(ok, ko),
  }
  return b
}

const fakeClient = {
  from,
  rpc: async (name: string, args: Record<string, unknown>) => {
    h.rpcCalls.push({ name, args })
    if (name === 'bump_conversation_on_inbound') {
      const c = (h.tables.conversations ?? []).find((r) => r.id === args.p_conversation_id)
      if (c) Object.assign(c, { unread_count: Number(c.unread_count ?? 0) + 1, last_message_text: args.p_last_message_text })
    }
    return { data: null, error: null }
  },
  storage: { from: () => ({ upload: async () => ({ error: { message: 'storage not used in these tests' } }), getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }))
vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => { h.afterCallbacks.push(cb) },
  NextResponse: { json: (body: unknown, init?: { status?: number }) => new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }) },
}))
vi.mock('@/lib/automations/engine', () => ({
  resumeAwaitingReply: async () => false,
  runAutomationsForTrigger: async (a: unknown) => { h.automations.push(a) },
}))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: async (a: unknown) => { h.aiReplies.push(a) } }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: async (...a: unknown[]) => { h.publicEvents.push(a[2]) } }))

// ---------------------------------------------------------------------------------------------------
// Gateway + mock SendZen (oralink/, zero-dependency .mjs) and the module under test.
// ---------------------------------------------------------------------------------------------------
const load = (f: string) => import(/* @vite-ignore */ pathToFileURL(resolve(process.cwd(), 'oralink', f)).href)

type Call = { method: string; url: string; auth: string; body: Row & { interactive?: Row } }
type Mock = { calls: Call[]; base: string; server: Closable }
type Closable = { close: (cb?: () => void) => void; closeAllConnections?: () => void }
type Listening = Closable & { listen: (p: number, host: string, cb: () => void) => void; address: () => { port: number } }
type Builders = {
  signWebhook: (secret: string, raw: string) => string
  inboundEnvelope: (a: { phoneNumberId: string; waId: string; name?: string; message: Row }) => Row
  inboundText: (a: { id: string; text: string; timestamp?: string }) => Row
  tapButton: (call: Call, sentId: string, index: number, a: { id: string }) => Row
  chooseRow: (call: Call, sentId: string, s: number, r: number, a: { id: string }) => Row
}
const closeIt = (s: Closable) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.() })

const SECRET_TZ = 'ci-dummy-sendzen-webhook-secret-tranzit'
const SECRET_IM = 'ci-dummy-sendzen-webhook-secret-immerview'
const PNID_TZ = '111111111111111'
const PNID_IM = '222222222222222'
const KEY_TZ = 'sz_ci_dummy_key_tranzit'
const KEY_IM = 'sz_ci_dummy_key_immerview'
const CUSTOMER = '15555550199' // fictitious: North American 555-01xx range reserved for fiction

let mock: Mock
let gateway: Listening
let B: Builders
let POST: (req: Request) => Promise<Response>
let encrypt: (s: string) => string
let mockSeq = 0

beforeAll(async () => {
  const m = await load('sendzen-gateway/test/mock-sendzen.mjs')
  const { createGateway, loadConfig } = await load('sendzen-gateway/server.mjs')
  B = m as unknown as Builders
  mock = await m.startMockSendzen(() => ({ status: 202, json: { message_id: `wamid.SZ.${++mockSeq}`, status: 'accepted', timestamp: '1' } }))
  gateway = createGateway(
    loadConfig({ SENDZEN_API_BASE: mock.base, NUMBER_MAP: JSON.stringify({ [PNID_TZ]: { from: '+15555550100' }, [PNID_IM]: { from: '+15555550101' } }) }),
    { log: () => {} },
  )
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r))
  vi.stubEnv('WHATSAPP_API_BASE_URL', `http://127.0.0.1:${gateway.address().port}/v21.0`)
  vi.stubEnv('META_APP_SECRET', `${SECRET_TZ}, ${SECRET_IM}`)
  vi.resetModules()
  POST = (await import('./route')).POST
  encrypt = (await import('@/lib/whatsapp/encryption')).encrypt
}, 60_000) // cold import of the whole webhook module graph

afterAll(async () => {
  vi.unstubAllEnvs()
  await closeIt(gateway)
  await closeIt(mock.server)
})

// Two accounts (TranZit, Immerview), each with its own number, SendZen key and keyword flow.
function seed() {
  h.tables = {
    whatsapp_config: [
      { id: 'cfg-tz', account_id: 'acc-tz', user_id: 'user-tz', phone_number_id: PNID_TZ, access_token: encrypt(KEY_TZ), mirror_inbound_media: false },
      { id: 'cfg-im', account_id: 'acc-im', user_id: 'user-im', phone_number_id: PNID_IM, access_token: encrypt(KEY_IM), mirror_inbound_media: false },
    ],
    flows: [
      { id: 'flow-tz', account_id: 'acc-tz', user_id: 'user-tz', status: 'active', trigger_type: 'keyword', trigger_config: { keywords: ['OL-TZ-BF1'] }, entry_node_id: 'start', created_at: '2026-01-01T00:00:00Z', fallback_policy: null },
      { id: 'flow-im', account_id: 'acc-im', user_id: 'user-im', status: 'active', trigger_type: 'keyword', trigger_config: { keywords: ['OL-IM-BF1'] }, entry_node_id: 'start', created_at: '2026-01-01T00:00:00Z', fallback_policy: null },
    ],
    flow_nodes: [
      { id: 'n1', flow_id: 'flow-tz', node_key: 'start', node_type: 'start', config: { next_node_key: 'profile' } },
      { id: 'n2', flow_id: 'flow-tz', node_key: 'profile', node_type: 'send_buttons', config: {
        text: 'Bienvenue chez TranZit ! Vous êtes ?', footer_text: 'Répondez STOP pour ne plus recevoir de messages',
        buttons: [
          { reply_id: 'tz_driver', title: 'Chauffeur', next_node_key: 'city' },
          { reply_id: 'tz_carrier', title: 'Transporteur', next_node_key: 'city' },
          { reply_id: 'tz_other', title: 'Autre', next_node_key: 'thanks' },
        ] } },
      { id: 'n3', flow_id: 'flow-tz', node_key: 'city', node_type: 'send_list', config: {
        text: 'Votre ville ?', button_label: 'Choisir',
        sections: [{ title: 'Villes', rows: [
          { reply_id: 'city_casa', title: 'Casablanca', description: 'Grand Casablanca', next_node_key: 'thanks' },
          { reply_id: 'city_rabat', title: 'Rabat', next_node_key: 'thanks' },
          { reply_id: 'city_tanger', title: 'Tanger', next_node_key: 'thanks' },
        ] }] } },
      { id: 'n4', flow_id: 'flow-tz', node_key: 'thanks', node_type: 'send_message', config: { text: 'Merci ! Un conseiller vous recontacte.', next_node_key: 'done' } },
      { id: 'n5', flow_id: 'flow-tz', node_key: 'done', node_type: 'end', config: {} },
      { id: 'm1', flow_id: 'flow-im', node_key: 'start', node_type: 'start', config: { next_node_key: 'hello' } },
      { id: 'm2', flow_id: 'flow-im', node_key: 'hello', node_type: 'send_message', config: { text: 'Bienvenue chez Immerview', next_node_key: 'end' } },
      { id: 'm3', flow_id: 'flow-im', node_key: 'end', node_type: 'end', config: {} },
    ],
  }
}

beforeEach(() => {
  seed()
  h.afterCallbacks = []
  h.rpcCalls = []
  h.automations = []
  h.aiReplies = []
  h.publicEvents = []
  mock.calls.length = 0
  mockSeq = 0
})

const rows = (t: string, where: Row = {}) => (h.tables[t] ?? []).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))

function webhook(raw: string, signature: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['x-hub-signature-256'] = signature
  return new Request('http://localhost/api/whatsapp/webhook', { method: 'POST', headers, body: raw })
}
/** Deliver a webhook and drain after() exactly as the runtime would. */
async function deliver(raw: string, signature: string | null) {
  const res = await POST(webhook(raw, signature))
  const cbs = h.afterCallbacks.splice(0)
  for (const cb of cbs) await cb()
  return res
}
function inbound(message: Row, phoneNumberId = PNID_TZ) {
  return JSON.stringify(B.inboundEnvelope({ phoneNumberId, waId: CUSTOMER, name: 'Client Test', message }))
}

// ===================================================================================================
describe('MAQUETTE — W-01 signature: X-Hub-Signature-256 with a multi-valued META_APP_SECRET', () => {
  const raw = () => inbound(B.inboundText({ id: 'wamid.SIG.1', text: 'Bonjour' }))

  it('accepts a body signed with ANY secret of the list (TranZit and Immerview webhooks)', async () => {
    const r1 = await deliver(raw(), B.signWebhook(SECRET_TZ, raw()))
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ status: 'received' })
    const other = inbound(B.inboundText({ id: 'wamid.SIG.2', text: 'Salam' }), PNID_IM)
    const r2 = await deliver(other, B.signWebhook(SECRET_IM, other))
    expect(r2.status).toBe(200)
    expect(rows('messages', { sender_type: 'customer' }).map((m) => m.message_id)).toEqual(['wamid.SIG.1', 'wamid.SIG.2'])
  })

  it.each([
    ['absent header', () => null],
    ['empty header', () => ''],
    ['wrong secret', () => B.signWebhook('ci-dummy-someone-else', raw())],
    ['signature of another body', () => B.signWebhook(SECRET_TZ, raw() + ' ')],
    ['bare hex (no sha256= prefix)', () => B.signWebhook(SECRET_TZ, raw()).slice('sha256='.length)],
    ['uppercase hex', () => 'sha256=' + B.signWebhook(SECRET_TZ, raw()).slice(7).toUpperCase()],
    ['sha1= prefix', () => B.signWebhook(SECRET_TZ, raw()).replace('sha256=', 'sha1=')],
    ['base64 digest', () => 'sha256=' + Buffer.from(B.signWebhook(SECRET_TZ, raw()).slice(7), 'hex').toString('base64')],
  ])('rejects %s with 401 and processes nothing', async (_label, sig) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await deliver(raw(), sig())
    expect(warn).toHaveBeenCalledWith('[webhook] rejected request with invalid signature')
    warn.mockRestore()
    expect(res.status).toBe(401)
    expect(h.afterCallbacks).toHaveLength(0)
    expect(rows('messages')).toHaveLength(0)
    expect(rows('contacts')).toHaveLength(0)
    expect(mock.calls).toHaveLength(0)
  })

  it('rejects a tampered body even when the header is the original valid signature', async () => {
    const good = raw()
    const tampered = good.replace('Bonjour', 'Bonsoir')
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {})
    expect((await deliver(tampered, B.signWebhook(SECRET_TZ, good))).status).toBe(401)
    expect(rows('messages')).toHaveLength(0)
  })

  it('fails closed when META_APP_SECRET is empty', async () => {
    vi.stubEnv('META_APP_SECRET', ' , ')
    try {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementationOnce(() => {})
      expect((await deliver(raw(), B.signWebhook(SECRET_TZ, raw()))).status).toBe(401)
      err.mockRestore()
    } finally {
      vi.stubEnv('META_APP_SECRET', `${SECRET_TZ}, ${SECRET_IM}`)
    }
  })
})

// ===================================================================================================
describe('MAQUETTE — W-02 idempotence: SendZen re-delivering the same wamid', () => {
  it('a replayed delivery (same body, same signature) creates ONE message, ONE contact, ONE flow run, ONE outbound send', async () => {
    const raw = inbound(B.inboundText({ id: 'wamid.DUP.1', text: 'OL-TZ-BF1' }))
    const sig = B.signWebhook(SECRET_TZ, raw)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) expect((await deliver(raw, sig)).status).toBe(200)
    expect(info).toHaveBeenCalledWith('[webhook] duplicate inbound message ignored (idempotent replay):', 'wamid.DUP.1')
    info.mockRestore()

    expect(rows('messages', { sender_type: 'customer' })).toHaveLength(1)
    expect(rows('contacts')).toHaveLength(1)
    expect(rows('conversations')).toHaveLength(1)
    expect(rows('conversations')[0].unread_count).toBe(1)
    expect(rows('flow_runs')).toHaveLength(1)
    expect(mock.calls).toHaveLength(1) // the bot's buttons were NOT re-sent on replay
    expect(rows('messages', { sender_type: 'bot' })).toHaveLength(1)
    expect(h.publicEvents.filter((e) => e === 'message.received')).toHaveLength(1)
  })

  it('the same wamid re-serialised differently (new signature) is still deduplicated', async () => {
    const msg = B.inboundText({ id: 'wamid.DUP.2', text: 'Bonjour' })
    const a = inbound(msg)
    const b = JSON.stringify(JSON.parse(a), null, 2) // other bytes, same event
    await deliver(a, B.signWebhook(SECRET_TZ, a))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await deliver(b, B.signWebhook(SECRET_IM, b))
    info.mockRestore()
    expect(rows('messages', { message_id: 'wamid.DUP.2' })).toHaveLength(1)
  })

  it('two concurrent deliveries of the same wamid (retry racing the original) still leave one message', async () => {
    const raw = inbound(B.inboundText({ id: 'wamid.DUP.3', text: 'Bonjour' }))
    const sig = B.signWebhook(SECRET_TZ, raw)
    const quiet = [vi.spyOn(console, 'info').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})]
    await Promise.all([POST(webhook(raw, sig)), POST(webhook(raw, sig))])
    await Promise.all(h.afterCallbacks.splice(0).map((cb) => cb()))
    quiet.forEach((s) => s.mockRestore())
    expect(rows('messages', { message_id: 'wamid.DUP.3' })).toHaveLength(1)
    expect(rows('contacts')).toHaveLength(1)
    expect(rows('conversations')).toHaveLength(1)
  })

  it('a replayed button tap does not advance the flow twice', async () => {
    const start = inbound(B.inboundText({ id: 'wamid.IN.1', text: 'OL-TZ-BF1' }))
    await deliver(start, B.signWebhook(SECRET_TZ, start))
    const tap = inbound(B.tapButton(mock.calls[0], 'wamid.SZ.1', 0, { id: 'wamid.IN.2' }))
    const sig = B.signWebhook(SECRET_TZ, tap)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await deliver(tap, sig)
    await deliver(tap, sig)
    info.mockRestore()
    expect(mock.calls.map((c) => (c.body.interactive as Row | undefined)?.type ?? c.body.type)).toEqual(['button', 'list'])
    expect(rows('flow_runs')[0].current_node_key).toBe('city')
  })
})

// ===================================================================================================
describe('MAQUETTE — W-03 end to end (local): QR keyword OL-TZ-BF1 → flow → buttons through the Z′ gateway → mock SendZen', () => {
  it('runs the native keyword flow and sends Meta-shaped reply buttons to SendZen with the TranZit key and sender', async () => {
    const raw = inbound(B.inboundText({ id: 'wamid.IN.10', text: 'OL-TZ-BF1' }))
    expect((await deliver(raw, B.signWebhook(SECRET_TZ, raw))).status).toBe(200)

    // What SendZen (mock) received — exactly one call, nothing Meta-only, the right key and sender.
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]).toMatchObject({ method: 'POST', url: '/v1/messages', auth: `Bearer ${KEY_TZ}` })
    expect(mock.calls[0].body).toEqual({
      from: '+15555550100',
      to: CUSTOMER,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Bienvenue chez TranZit ! Vous êtes ?' },
        footer: { text: 'Répondez STOP pour ne plus recevoir de messages' },
        action: { buttons: [
          { type: 'reply', reply: { id: 'tz_driver', title: 'Chauffeur' } },
          { type: 'reply', reply: { id: 'tz_carrier', title: 'Transporteur' } },
          { type: 'reply', reply: { id: 'tz_other', title: 'Autre' } },
        ] },
      },
    })

    // What waCRM recorded — all in the TranZit account, nothing in Immerview.
    const [contact] = rows('contacts')
    expect(contact).toMatchObject({ account_id: 'acc-tz', phone: CUSTOMER, name: 'Client Test' })
    const [conv] = rows('conversations')
    expect(conv).toMatchObject({ account_id: 'acc-tz', contact_id: contact.id, unread_count: 1 })
    expect(rows('messages', { sender_type: 'customer' })).toMatchObject([{ conversation_id: conv.id, content_text: 'OL-TZ-BF1', message_id: 'wamid.IN.10' }])
    const [bot] = rows('messages', { sender_type: 'bot' })
    expect(bot).toMatchObject({ conversation_id: conv.id, content_type: 'interactive', message_id: 'wamid.SZ.1', status: 'sent' })
    const [run] = rows('flow_runs')
    expect(run).toMatchObject({ flow_id: 'flow-tz', account_id: 'acc-tz', status: 'active', current_node_key: 'profile', last_prompt_message_id: bot.id })
    expect(rows('contacts', { account_id: 'acc-im' })).toHaveLength(0)
    // The flow consumed the keyword: content-level automations and the AI reply did not fire.
    expect(h.aiReplies).toHaveLength(0)
    expect((h.automations as { triggerType: string }[]).map((a) => a.triggerType)).not.toContain('keyword_match')
  })

  it('button_reply → list through the gateway; list_reply → text; the run completes', async () => {
    const start = inbound(B.inboundText({ id: 'wamid.IN.20', text: 'OL-TZ-BF1' }))
    await deliver(start, B.signWebhook(SECRET_TZ, start))

    const tap = inbound(B.tapButton(mock.calls[0], 'wamid.SZ.1', 0, { id: 'wamid.IN.21' }))
    await deliver(tap, B.signWebhook(SECRET_TZ, tap))
    expect(rows('messages', { message_id: 'wamid.IN.21' })).toMatchObject([{ content_type: 'interactive', interactive_reply_id: 'tz_driver', content_text: 'Chauffeur' }])
    expect(mock.calls[1].body).toEqual({
      from: '+15555550100', to: CUSTOMER, type: 'interactive',
      interactive: { type: 'list', body: { text: 'Votre ville ?' }, action: { button: 'Choisir', sections: [{ title: 'Villes', rows: [
        { id: 'city_casa', title: 'Casablanca', description: 'Grand Casablanca' },
        { id: 'city_rabat', title: 'Rabat' },
        { id: 'city_tanger', title: 'Tanger' },
      ] }] } },
    })

    const pick = inbound(B.chooseRow(mock.calls[1], 'wamid.SZ.2', 0, 0, { id: 'wamid.IN.22' }))
    await deliver(pick, B.signWebhook(SECRET_TZ, pick))
    expect(rows('messages', { message_id: 'wamid.IN.22' })).toMatchObject([{ interactive_reply_id: 'city_casa' }])
    expect(mock.calls[2].body).toEqual({ from: '+15555550100', to: CUSTOMER, type: 'text', text: { body: 'Merci ! Un conseiller vous recontacte.' } })
    expect(rows('flow_runs')[0]).toMatchObject({ status: 'completed', end_reason: 'end_node' })
    expect(mock.calls.every((c) => c.auth === `Bearer ${KEY_TZ}` && c.url === '/v1/messages')).toBe(true)
    // The swipe-reply context resolves to the bot prompt we stored.
    const prompt = rows('messages', { message_id: 'wamid.SZ.1' })[0]
    expect(rows('messages', { message_id: 'wamid.IN.21' })[0].reply_to_message_id).toBe(prompt.id)
  })

  it('the other account: OL-IM-BF1 on the Immerview number uses the Immerview key and sender only', async () => {
    const raw = inbound(B.inboundText({ id: 'wamid.IN.30', text: 'OL-IM-BF1' }), PNID_IM)
    await deliver(raw, B.signWebhook(SECRET_IM, raw))
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]).toMatchObject({ auth: `Bearer ${KEY_IM}`, body: { from: '+15555550101', type: 'text', text: { body: 'Bienvenue chez Immerview' } } })
    expect(rows('contacts').map((c) => c.account_id)).toEqual(['acc-im'])
  })

  it('the TranZit keyword sent to the Immerview number starts nothing and sends nothing', async () => {
    const raw = inbound(B.inboundText({ id: 'wamid.IN.40', text: 'OL-TZ-BF1' }), PNID_IM)
    await deliver(raw, B.signWebhook(SECRET_IM, raw))
    expect(rows('flow_runs')).toHaveLength(0)
    expect(mock.calls).toHaveLength(0)
  })

  it('a gateway refusal (number missing from NUMBER_MAP) fails the run visibly: no fake success, SendZen not called', async () => {
    // A third account whose number the gateway does not know (operator forgot NUMBER_MAP).
    h.tables.whatsapp_config.push({ id: 'cfg-x', account_id: 'acc-x', user_id: 'user-x', phone_number_id: '333333333333333', access_token: encrypt('sz_ci_dummy_key_x'), mirror_inbound_media: false })
    h.tables.flows.push({ ...h.tables.flows[0], id: 'flow-x', account_id: 'acc-x', user_id: 'user-x' })
    for (const n of h.tables.flow_nodes.filter((n) => n.flow_id === 'flow-tz')) h.tables.flow_nodes.push({ ...n, id: `x-${n.id}`, flow_id: 'flow-x' })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const raw = inbound(B.inboundText({ id: 'wamid.IN.51', text: 'OL-TZ-BF1' }), '333333333333333')
    expect((await deliver(raw, B.signWebhook(SECRET_TZ, raw))).status).toBe(200)
    quiet.mockRestore()
    expect(mock.calls).toHaveLength(0)
    const [run] = rows('flow_runs', { account_id: 'acc-x' })
    expect(run).toMatchObject({ status: 'failed', end_reason: 'send_buttons_failed' })
    const [err] = rows('flow_run_events', { flow_run_id: run.id, event_type: 'error' })
    expect(String((err.payload as Row).detail)).toMatch(/Unknown phone number id for this gateway/)
    expect(rows('messages', { sender_type: 'bot' })).toHaveLength(0)
  })
})
