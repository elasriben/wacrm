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
import { existsSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type DbError = { code: string; message: string } | null
type Result = { data: unknown; error: DbError; count?: number | null }

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  queryErrors: [] as string[],
  consentReadError: false,
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
  if (column.includes('.')) { const [relation, field] = column.split('.'); return (row[relation] as Row | undefined)?.[field] }
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

// Deliberately narrow contract, not a PostgREST emulator. Unsupported syntax must fail.
const SELECT_COLUMNS: Record<string, string[]> = {
  whatsapp_config: ['id', 'verify_token', 'account_id', 'phone_number_id', 'access_token', 'mirror_inbound_media'],
  contacts: ['id', 'phone', 'wa_user_id', 'name', 'custom_fields', 'account_id'],
  contact_consent_current: ['purpose', 'status', 'contact_id'],
  conversations: ['id', 'contact_id', 'account_id', 'status'],
  messages: ['id', 'message_id', 'conversation_id'],
  flows: ['id'], flow_nodes: ['id'], flow_runs: ['id'], flow_run_events: ['id'],
  contact_tags: ['contact_id'], broadcast_recipients: ['id', 'status', 'sent_at', 'broadcasts!inner(account_id)'],
}
function queryContractError(message: string): never {
  h.queryErrors.push(message)
  throw new Error(message)
}
function projection(table: string, columns: string) {
  if (!Object.hasOwn(SELECT_COLUMNS, table)) queryContractError(`unsupported select table: ${table}`)
  if (columns === '*') return (row: Row) => structuredClone(row)
  const names = columns.split(',').map((c) => c.trim())
  if (!names.length || names.some((c) => !SELECT_COLUMNS[table].includes(c))) queryContractError(`unsupported select projection: ${table}.${columns}`)
  return (row: Row) => Object.fromEntries(names.map((c) => c === 'broadcasts!inner(account_id)' ? ['broadcasts', structuredClone(row.broadcasts)] : [c, structuredClone(row[c] ?? null)]))
}

// Migration 900: latest journal row per complete tuple, BEFORE PostgREST filters.
function consentTimestamp(value: unknown): bigint {
  const m = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value)
  if (!m) queryContractError('invalid consent timestamp fixture')
  const seconds = Date.parse(`${m[1]}Z`)
  if (!Number.isFinite(seconds) || new Date(seconds).toISOString().slice(0, 19) !== m[1]) queryContractError('invalid consent timestamp fixture')
  return BigInt(seconds) * BigInt(1000) + BigInt((m[2] ?? '').padEnd(6, '0'))
}
function consentSequence(value: unknown): bigint {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > BigInt('9223372036854775807')) queryContractError('invalid consent sequence fixture')
  return BigInt(text)
}
function currentConsentRows(): Row[] {
  const journal = h.tables.contact_consents
  if (!Array.isArray(journal)) queryContractError('consent journal fixture required')
  if (Object.hasOwn(h.tables, 'contact_consent_current')) queryContractError('consent view must be derived, not seeded')
  const latest = new Map<string, { row: Row; time: bigint; seq: bigint }>()
  const ids = new Set<string>()
  for (const row of journal) {
    if (typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.account_id !== 'string' || !row.account_id || typeof row.contact_id !== 'string' || !row.contact_id || row.channel !== 'whatsapp' || typeof row.purpose !== 'string' || !['service', 'marketing'].includes(row.purpose) || typeof row.status !== 'string' || !['granted', 'revoked'].includes(row.status)) queryContractError('invalid consent journal fixture')
    if (!(h.tables.contacts ?? []).some((c) => c.id === row.contact_id && c.account_id === row.account_id)) queryContractError('consent contact/account fixture mismatch')
    if (typeof row.source !== 'string' || (!['inbound', 'manual', 'import'].includes(row.source) && !/^OL-[A-Z0-9]{2,8}-[A-Z0-9]{2,16}$/.test(row.source)) || (row.evidence != null && (typeof row.evidence !== 'string' || [...row.evidence].length > 200))) queryContractError('invalid consent evidence/source fixture')
    ids.add(row.id)
    const time = consentTimestamp(row.recorded_at); const seq = consentSequence(row.seq)
    const key = JSON.stringify([row.account_id, row.contact_id, row.channel, row.purpose])
    const previous = latest.get(key)
    if (previous && time === previous.time && seq === previous.seq) queryContractError('ambiguous consent ordering fixture')
    if (!previous || time > previous.time || (time === previous.time && seq > previous.seq)) latest.set(key, { row, time, seq })
  }
  return [...latest.values()].sort((a, b) => {
    for (const column of ['account_id', 'contact_id', 'channel', 'purpose']) {
      if (a.row[column] !== b.row[column]) return String(a.row[column]) < String(b.row[column]) ? -1 : 1
    }
    return 0
  }).map(({ row }) => ({
    account_id: row.account_id, contact_id: row.contact_id, channel: row.channel,
    purpose: row.purpose, status: row.status, source: row.source, evidence: row.evidence ?? null,
    recorded_at: row.recorded_at, recorded_by: row.recorded_by ?? null, consent_id: row.id,
  }))
}
type QueryFilter = { op: string; column: string; value: unknown }
function consentQuery(columns: string, filters: QueryFilter[]) {
  const eq = (column: string, value?: unknown) => filters.some((f) => f.op === 'eq' && f.column === column && (value === undefined ? typeof f.value === 'string' && Boolean(f.value) : f.value === value))
  const shape = filters.map((f) => `${f.op}:${f.column}`).sort().join(',')
  if (columns === 'purpose,status' && shape === 'eq:account_id,eq:channel,eq:contact_id' && eq('account_id') && eq('contact_id') && eq('channel', 'whatsapp')) return
  const batch = filters.find((f) => f.op === 'in' && f.column === 'contact_id')
  if (columns === 'contact_id' && shape === 'eq:account_id,eq:channel,eq:status,in:contact_id' && eq('account_id') && eq('channel', 'whatsapp') && eq('status', 'revoked') && Array.isArray(batch?.value) && batch.value.every((v) => typeof v === 'string' && Boolean(v))) return
  queryContractError('unsupported or unscoped consent view query')
}

function from(table: string) {
  const consentView = table === 'contact_consent_current'
  const rows = consentView ? [] : (h.tables[table] ??= [])
  const queryFilters: QueryFilter[] = []
  let columns = ''
  const addFilter = (op: string, column: string, value: unknown, predicate: (r: Row) => boolean) => { queryFilters.push({ op, column, value }); filters.push(predicate) }
  const filters: ((r: Row) => boolean)[] = []
  let op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select'
  let patch: Row = {}
  let pending: Row[] = []
  let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  let limit: number | null = null
  let order: { col: string; asc: boolean } | null = null
  let head = false
  let project = projection(table, '*')
  let returning = false
  let innerBroadcast = false
  const output = (list: Row[]) => head ? null : list.map(project)

  const execute = (): Result => {
    for (const f of queryFilters) {
      if (f.column.includes('.') && !(table === 'broadcast_recipients' && f.column === 'broadcasts.account_id' && f.op === 'eq' && innerBroadcast && op === 'select')) queryContractError('unsupported relation filter: inner broadcast join required')
    }
    if (consentView) {
      if (op !== 'select' || !returning || head || order || limit !== null) queryContractError('unsupported consent view operation')
      consentQuery(columns, queryFilters)
      if (h.consentReadError) return { data: null, error: { code: 'XX000', message: 'simulated consent read failure' } }
      const current = currentConsentRows()
      return { data: output(current.filter((r) => filters.every((f) => f(r)))), error: null }
    }
    if (op === 'insert' || op === 'upsert') {
      if (op === 'upsert' && (table !== 'messages' || upsertOpts.onConflict !== 'conversation_id,message_id' || upsertOpts.ignoreDuplicates !== true)) queryContractError('unsupported onConflict/upsert contract')
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
      return { data: returning ? output(out) : null, error: null }
    }
    // The only embedded relation exercised here is the FK broadcast_id -> broadcasts.id.
    const source: Row[] = innerBroadcast ? rows.flatMap((r) => {
      const parent = (h.tables.broadcasts ?? []).find((b) => b.id === r.broadcast_id)
      return parent ? [{ ...r, broadcasts: { account_id: parent.account_id } }] : []
    }) : rows
    const matched = source.filter((r) => filters.every((f) => f(r)))
    if (op === 'update') {
      for (const r of matched) {
        const before = { ...r }
        Object.assign(r, structuredClone(patch))
        const clash = conflicts(table, r, rows)
        if (clash) { Object.assign(r, before); return { data: null, error: uniqueError(clash) } }
      }
      return { data: returning ? output(matched) : null, error: null }
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
    return { data: output(list), error: null, count: matched.length }
  }

  const b = {
    select: (cols = '*', opts?: { head?: boolean }) => { if (consentView && (opts || !['purpose,status', 'contact_id'].includes(cols.replace(/\s/g, '')))) queryContractError('unsupported consent view projection'); columns = cols.replace(/\s/g, ''); project = projection(table, cols); innerBroadcast = cols.split(',').map((c) => c.trim()).includes('broadcasts!inner(account_id)'); returning = true; if (opts?.head) head = true; return b },
    eq: (c: string, v: unknown) => { addFilter('eq', c, v, (r) => readColumn(r, c) === v); return b },
    neq: (c: string, v: unknown) => { addFilter('neq', c, v, (r) => readColumn(r, c) !== v); return b },
    is: (c: string, v: unknown) => { addFilter('is', c, v, (r) => (readColumn(r, c) ?? null) === v); return b },
    in: (c: string, vs: unknown[]) => { addFilter('in', c, vs, (r) => vs.includes(readColumn(r, c))); return b },
    filter: (c: string, operator: string, v: unknown) => { if (operator !== 'eq') queryContractError('unsupported filter operator'); addFilter('filter:eq', c, v, (r) => readColumn(r, c) === v); return b },
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
    contact_consents: [],
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
  h.queryErrors = []
  h.consentReadError = false
  seed()
  h.afterCallbacks = []
  h.rpcCalls = []
  h.automations = []
  h.aiReplies = []
  h.publicEvents = []
  mock.calls.length = 0
  mockSeq = 0
})

// Application code may catch query errors: the test must still fail on an unsupported request.
afterEach(() => { expect(h.queryErrors).toEqual([]) })

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

// Negative contract tests: these must fail if the fake stops enforcing queries.
describe('Supabase fake query contract', () => {
  it('projects only requested columns and rejects unknown/unsupported projections even with no rows', async () => {
    const result = await from('contacts').insert({ phone: '123', account_id: 'a', name: 'hidden' }).select('id')
    expect(Object.keys((result.data as Row[])[0])).toEqual(['id'])
    expect(() => from('contacts').select('nonexistent')).toThrow(/projection/)
    expect(() => from('messages').select('contacts(*)')).toThrow(/projection/)
    expect(() => from('messages').select('id,,')).toThrow(/projection/)
    expect(h.queryErrors.splice(0)).toHaveLength(3)
  })
  it('rejects wrong or omitted conflict targets and unsupported merge semantics', async () => {
    for (const opts of [undefined, { onConflict: 'message_id', ignoreDuplicates: true }, { onConflict: 'conversation_id,message_id', ignoreDuplicates: false }]) {
      await expect(Promise.resolve(from('messages').upsert({ message_id: 'x' }, opts))).rejects.toThrow(/onConflict/)
    }
    expect(h.tables.messages ?? []).toHaveLength(0)
    expect(h.queryErrors.splice(0)).toHaveLength(3)
  })
  it('enforces the inner broadcast join, account filter and embedded projection', async () => {
    h.tables.broadcasts = [{ id: 'a', account_id: 'one' }, { id: 'b', account_id: 'two' }]
    h.tables.broadcast_recipients = [
      { id: 'ra', broadcast_id: 'a', status: 'sent', sent_at: 'now', secret: 'hidden' },
      { id: 'rb', broadcast_id: 'b', status: 'sent' },
      { id: 'orphan', broadcast_id: 'missing', status: 'sent' },
    ]
    const result = await from('broadcast_recipients').select('id, status, sent_at, broadcasts!inner(account_id)').eq('broadcasts.account_id', 'one')
    expect(result.data).toEqual([{ id: 'ra', status: 'sent', sent_at: 'now', broadcasts: { account_id: 'one' } }])
    const all = await from('broadcast_recipients').select('id, broadcasts!inner(account_id)')
    expect((all.data as Row[]).map((r) => r.id)).toEqual(['ra', 'rb'])
    expect(() => from('broadcast_recipients').select('broadcasts!inner(nonexistent)')).toThrow(/projection/)
    expect(h.queryErrors.splice(0)).toHaveLength(1)
  })
  it('records contract violations even when a caller catches the exception', () => {
    try { from('messages').select('nonexistent') } catch { /* simulate swallowed application error */ }
    expect(h.queryErrors.splice(0)).toEqual(['unsupported select projection: messages.nonexistent'])
  })
  it('does not treat a conflicting insert as a returned new message or leak unselected fields', async () => {
    const row = { conversation_id: 'c', message_id: 'm', content_text: 'hidden' }
    const opts = { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    const first = await from('messages').upsert(row, opts).select('id')
    expect(Object.keys((first.data as Row[])[0])).toEqual(['id'])
    expect((await from('messages').upsert(row, opts).select('id')).data).toEqual([])
    expect((await from('messages').insert({ message_id: 'other' })).data).toBeNull()
  })
})

// STRICT cases are additional to the 74 original P0 + PR9 targeted tests.
describe('STRICT broadcast filter contract', () => {
  it('rejects account filters without the selected inner join, including empty data and reversed builder order', async () => {
    for (const query of [
      from('broadcast_recipients').select('id').eq('broadcasts.account_id', 'one'),
      from('broadcast_recipients').eq('broadcasts.account_id', 'one').select('id'),
      from('broadcast_recipients').select('id, broadcasts!inner(account_id)').eq('broadcasts.account_id', 'one').select('id'),
      from('broadcast_recipients').select('id, broadcasts!inner(account_id)').neq('broadcasts.account_id', 'one'),
      from('messages').select('id').eq('broadcasts.account_id', 'one'),
    ]) {
      await expect(Promise.resolve(query)).rejects.toThrow(/inner broadcast join/)
      expect(h.queryErrors.splice(0)).toHaveLength(1)
    }
  })
})

const consentFixture = (journal: Row[] = []) => {
  h.tables.contacts = [
    { id: 'c-one', account_id: 'a-one' }, { id: 'c-two', account_id: 'a-one' }, { id: 'c-other', account_id: 'a-other' },
  ]
  h.tables.contact_consents = journal
}
const consentEvent = (seq: number | string, status = 'granted', overrides: Row = {}): Row => ({
  id: `consent-${seq}`, seq, account_id: 'a-one', contact_id: 'c-one', channel: 'whatsapp',
  purpose: 'service', status, source: 'inbound', recorded_at: '2026-10-21T10:00:00.000000Z', ...overrides,
})
const consentStateQuery = () => from('contact_consent_current').select('purpose, status').eq('account_id', 'a-one').eq('contact_id', 'c-one').eq('channel', 'whatsapp')
const consentBatchQuery = () => from('contact_consent_current').select('contact_id').eq('account_id', 'a-one').eq('channel', 'whatsapp').eq('status', 'revoked').in('contact_id', ['c-one', 'c-two'])

describe('STRICT consent view contract', () => {
  it('derives an empty view from an explicit empty journal, returning only requested columns', async () => {
    consentFixture()
    expect((await consentStateQuery()).data).toEqual([])
    h.tables.contact_consents.push(consentEvent(1))
    expect((await consentStateQuery()).data).toEqual([{ purpose: 'service', status: 'granted' }])
    expect(h.tables).not.toHaveProperty('contact_consent_current')
  })
  it('chooses the latest event before filtering revoked rows, not the first matching journal event', async () => {
    consentFixture([consentEvent(1, 'revoked'), consentEvent(2, 'granted')])
    expect((await consentStateQuery()).data).toEqual([{ purpose: 'service', status: 'granted' }])
    expect((await consentBatchQuery()).data).toEqual([])
    h.tables.contact_consents.push(consentEvent(3, 'revoked'))
    expect((await consentStateQuery()).data).toEqual([{ purpose: 'service', status: 'revoked' }])
    expect((await consentBatchQuery()).data).toEqual([{ contact_id: 'c-one' }])
  })
  it('orders tied timestamps by numeric BIGINT seq, not fixture order or lexicographic order', async () => {
    consentFixture([consentEvent('10', 'granted'), consentEvent('9', 'revoked')])
    expect((await consentStateQuery()).data).toEqual([{ purpose: 'service', status: 'granted' }])
    consentFixture([consentEvent('9007199254740993', 'revoked'), consentEvent('9007199254740992', 'granted')])
    expect((await consentStateQuery()).data).toEqual([{ purpose: 'service', status: 'revoked' }])
  })
  it('preserves timestamp microseconds and gives timestamp priority over seq', async () => {
    consentFixture([
      consentEvent(9, 'revoked', { recorded_at: '2026-10-21T10:00:00.000001Z' }),
      consentEvent(1, 'granted', { recorded_at: '2026-10-21T10:00:00.000002Z' }),
    ])
    expect((await consentStateQuery()).data).toEqual([{ purpose: 'service', status: 'granted' }])
  })
  it('keeps purposes, contacts and accounts separate and projects only the scoped state', async () => {
    consentFixture([
      consentEvent(1), consentEvent(2, 'revoked', { purpose: 'marketing' }),
      consentEvent(3, 'revoked', { contact_id: 'c-two' }),
      consentEvent(4, 'revoked', { account_id: 'a-other', contact_id: 'c-other' }),
    ])
    expect((await consentStateQuery()).data).toEqual([{ purpose: 'marketing', status: 'revoked' }, { purpose: 'service', status: 'granted' }])
    expect((await consentBatchQuery()).data).toEqual([{ contact_id: 'c-one' }, { contact_id: 'c-two' }])
  })
  it('recomputes the view at execution instead of caching a seeded view or builder snapshot', async () => {
    consentFixture([consentEvent(1)])
    const query = consentStateQuery()
    h.tables.contact_consents.push(consentEvent(2, 'revoked'))
    expect((await query).data).toEqual([{ purpose: 'service', status: 'revoked' }])
    h.tables.contact_consent_current = []
    await expect(Promise.resolve(consentStateQuery())).rejects.toThrow(/derived/)
    expect(h.queryErrors.splice(0)).toHaveLength(1)
  })
  it('rejects omitted or incorrect scope, duplicate filters and unsupported operators', async () => {
    consentFixture()
    for (const query of [
      from('contact_consent_current').select('purpose, status').eq('contact_id', 'c-one').eq('channel', 'whatsapp'),
      from('contact_consent_current').select('purpose, status').eq('account_id', 'a-one').eq('channel', 'whatsapp'),
      from('contact_consent_current').select('purpose, status').eq('account_id', 'a-one').eq('contact_id', 'c-one'),
      from('contact_consent_current').select('purpose, status').eq('account_id', 'a-one').eq('contact_id', 'c-one').eq('channel', 'sms'),
      consentStateQuery().eq('status', 'granted'), consentStateQuery().eq('account_id', 'a-one'),
      from('contact_consent_current').select('purpose, status').filter('account_id', 'eq', 'a-one').eq('contact_id', 'c-one').eq('channel', 'whatsapp'),
      consentStateQuery().in('unknown', []),
    ]) {
      await expect(Promise.resolve(query)).rejects.toThrow(/consent view query/)
      expect(h.queryErrors.splice(0)).toHaveLength(1)
    }
    expect(() => from('contact_consent_current').filter('account_id', 'like', '%')).toThrow(/operator/)
    expect(h.queryErrors.splice(0)).toHaveLength(1)
  })
  it('rejects wildcard, unknown projections and unsupported query modifiers even on an empty journal', async () => {
    consentFixture()
    for (const columns of ['*', 'unknown', 'purpose, status, evidence', 'purpose, status,', 'contacts(*)']) {
      expect(() => from('contact_consent_current').select(columns)).toThrow(/projection/)
      expect(h.queryErrors.splice(0)).toHaveLength(1)
    }
    for (const query of [consentStateQuery().limit(1), consentStateQuery().order('recorded_at'), from('contact_consent_current')]) {
      await expect(Promise.resolve(query)).rejects.toThrow(/operation/)
      expect(h.queryErrors.splice(0)).toHaveLength(1)
    }
  })
  it('refuses mutations of the view without altering the journal', async () => {
    consentFixture([consentEvent(1)])
    const before = structuredClone(h.tables.contact_consents)
    for (const query of [from('contact_consent_current').insert({}), from('contact_consent_current').update({}), from('contact_consent_current').upsert({}), from('contact_consent_current').delete()]) {
      await expect(Promise.resolve(query)).rejects.toThrow(/operation/)
      expect(h.queryErrors.splice(0)).toHaveLength(1)
    }
    expect(h.tables.contact_consents).toEqual(before)
  })
  it('rejects invalid journal fixtures instead of returning a misleading empty state', async () => {
    for (const patch of [
      { account_id: 'wrong-account' }, { channel: 'sms' }, { purpose: 'unknown' }, { purpose: ['service'] }, { status: 'unknown' }, { status: ['granted'] },
      { source: 'unknown' }, { evidence: 'x'.repeat(201) }, { seq: 0 }, { seq: Number.MAX_SAFE_INTEGER + 1 },
      { seq: '9223372036854775808' }, { recorded_at: 'invalid' }, { recorded_at: '2026-02-30T10:00:00Z' },
    ]) {
      consentFixture([consentEvent(1, 'granted', patch)])
      await expect(Promise.resolve(consentStateQuery())).rejects.toThrow(/fixture/)
      expect(h.queryErrors.splice(0)).toHaveLength(1)
    }
    delete h.tables.contact_consents
    await expect(Promise.resolve(consentStateQuery())).rejects.toThrow(/fixture required/)
    expect(h.queryErrors.splice(0)).toHaveLength(1)
  })
  it('returns an injected database error explicitly rather than a successful empty result', async () => {
    consentFixture()
    h.consentReadError = true
    expect(await consentStateQuery()).toEqual({ data: null, error: { code: 'XX000', message: 'simulated consent read failure' } })
  })

  // This branch contains no production CRM code. These integration cases run when validating with PR9.
  const withPr9 = it.runIf(existsSync(resolve(process.cwd(), 'src/lib/oralink/consent.ts')))
  const realGuard = () => vi.importActual<{ canSendAutomated: (account: string, contact: string) => Promise<boolean> }>('@/lib/oralink/consent')
  withPr9('calls the REAL consent guard: STOP blocks, START restores, and another purpose can still block', async () => {
    const { canSendAutomated } = await realGuard()
    consentFixture()
    expect(await canSendAutomated('a-one', 'c-one')).toBe(true)
    h.tables.contact_consents.push(consentEvent(1, 'revoked'))
    expect(await canSendAutomated('a-one', 'c-one')).toBe(false)
    h.tables.contact_consents.push(consentEvent(2, 'granted'))
    expect(await canSendAutomated('a-one', 'c-one')).toBe(true)
    h.tables.contact_consents.push(consentEvent(3, 'revoked', { purpose: 'marketing' }))
    expect(await canSendAutomated('a-one', 'c-one')).toBe(false)
    expect(await canSendAutomated('a-one', 'c-two')).toBe(true)
  })
  withPr9('keeps the REAL consent guard fail-closed on database errors without a bypass', async () => {
    const { canSendAutomated } = await realGuard()
    consentFixture()
    h.consentReadError = true
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try { expect(await canSendAutomated('a-one', 'c-one')).toBe(false) } finally { log.mockRestore() }
  })
})
