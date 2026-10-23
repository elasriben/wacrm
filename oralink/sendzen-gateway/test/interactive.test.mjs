// Contract tests: interactive reply buttons and lists through the gateway, against the MOCK SendZen.
// Proves: what the gateway forwards / refuses, and that the inbound replies the mock builds (Meta
// format) carry back the ids we sent. Proves nothing about the real SendZen (TEST-PLAN T-S3/T-S4).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createGateway, loadConfig } from '../server.mjs'
import { LIMITS, validateInteractive } from '../interactive-limits.mjs'
import { startMockSendzen, tapButton, chooseRow, inboundEnvelope } from './mock-sendzen.mjs'
import { CASES } from '../../sendzen-test-kit/payloads.mjs'

const closeServer = (s) => new Promise((resolve) => { const t = setTimeout(resolve, 1000); t.unref(); s.close(() => resolve()); s.closeAllConnections?.() })
const TOKEN = 'sz_test_dummy_token'
const PNID = '111111111111111'
let mock, gw, base, seq

before(async () => {
  mock = await startMockSendzen(() => ({ status: 202, json: { message_id: `wamid.MOCK.${++seq}`, status: 'accepted', timestamp: '1' } }))
  gw = createGateway(loadConfig({ SENDZEN_API_BASE: mock.base, NUMBER_MAP: JSON.stringify({ [PNID]: { from: '+15555550100' } }) }), { log: () => {} })
  await new Promise((r) => gw.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${gw.address().port}/v21.0/${PNID}/messages`
})
after(async () => { await closeServer(gw); await closeServer(mock.server) })
beforeEach(() => { mock.calls.length = 0; seq = 0 })

const send = (interactive) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '15555550199', type: 'interactive', interactive }) })
const x = (n, c = 'a') => c.repeat(n)
const buttons = (titles, extra = {}) => ({ type: 'button', body: { text: 'Vous êtes ?' }, ...extra, action: { buttons: titles.map((t, i) => ({ type: 'reply', reply: { id: `b${i}`, title: t } })) } })
const list = (rowsPerSection, extra = {}) => ({ type: 'list', body: { text: 'Votre ville ?' }, ...extra, action: { button: 'Choisir', sections: rowsPerSection.map((n, s) => ({ title: `Section ${s + 1}`, rows: Array.from({ length: n }, (_, r) => ({ id: `s${s}r${r}`, title: `Ville ${s}-${r}` })) })) } })

async function expectRefused(interactive, status, pattern) {
  const r = await send(interactive)
  assert.equal(r.status, status, JSON.stringify(interactive).slice(0, 120))
  const j = await r.json()
  assert.match(j.error.message, pattern)
  if (status === 400) { assert.equal(j.error.code, 131009); assert.equal(j.error.type, 'GatewayValidationError') }
  assert.equal(mock.calls.length, 0, 'SendZen must not be called for a refused payload')
}

test('limits match the WhatsApp/waCRM numbers', () => {
  assert.deepEqual({ b: LIMITS.maxButtons, bt: LIMITS.buttonTitleMax, rows: LIMITS.maxRowsTotal, rt: LIMITS.rowTitleMax, rd: LIMITS.rowDescriptionMax, body: LIMITS.bodyMax, h: LIMITS.headerTextMax, f: LIMITS.footerMax, lb: LIMITS.listButtonMax },
    { b: 3, bt: 20, rows: 10, rt: 24, rd: 72, body: 1024, h: 60, f: 60, lb: 20 })
})

test('buttons: 1 to 3 accepted at the limits (20-char titles, 1024-char body, 60-char header/footer)', async () => {
  const ok = buttons([x(20), x(20, 'b'), x(20, 'c')], { header: { type: 'text', text: x(60) }, footer: { text: x(60) } })
  ok.body.text = x(1024)
  const r = await send(ok)
  assert.equal(r.status, 200)
  assert.deepEqual(mock.calls[0].body.interactive, ok)
  assert.equal(mock.calls[0].body.recipient_type, undefined)
  assert.equal((await send(buttons(['Oui']))).status, 200)
})

test('buttons: titles counted in characters, not bytes (accents / emoji at the limit pass)', async () => {
  assert.equal((await send(buttons(['é'.repeat(20), '🚚'.repeat(20)]))).status, 200)
})

test('buttons: 0 or 4 buttons, 21-char title, empty/duplicate id, 257-char id, body/header/footer too long → 400, SendZen not called', async () => {
  await expectRefused(buttons([]), 400, /between 1 and 3 buttons/)
  await expectRefused(buttons(['A', 'B', 'C', 'D']), 400, /between 1 and 3 buttons are required \(got 4\)/)
  await expectRefused(buttons([x(21)]), 400, /reply.title exceeds 20/)
  const dup = buttons(['A', 'B']); dup.action.buttons[1].reply.id = 'b0'
  await expectRefused(dup, 400, /duplicate reply.id/)
  const noId = buttons(['A']); noId.action.buttons[0].reply.id = ''
  await expectRefused(noId, 400, /reply.id is required/)
  const longId = buttons(['A']); longId.action.buttons[0].reply.id = x(257)
  await expectRefused(longId, 400, /reply.id exceeds 256/)
  const longBody = buttons(['A']); longBody.body.text = x(1025)
  await expectRefused(longBody, 400, /body.text exceeds 1024/)
  await expectRefused(buttons(['A'], { header: { type: 'text', text: x(61) } }), 400, /header.text exceeds 60/)
  await expectRefused(buttons(['A'], { header: { type: 'image', image: { link: 'https://example.invalid/x.png' } } }), 501, /only a text header/)
  await expectRefused(buttons(['A'], { footer: { text: x(61) } }), 400, /footer.text exceeds 60/)
  const noBody = buttons(['A']); delete noBody.body
  await expectRefused(noBody, 400, /body.text is required/)
})

test('list: 10 rows accepted (one or several sections), 24-char row title, 72-char description, 20-char label', async () => {
  assert.equal((await send(list([10]))).status, 200)
  assert.equal((await send(list([3, 3, 4]))).status, 200)
  const edge = list([1]); edge.action.button = x(20); edge.action.sections[0].title = x(24)
  Object.assign(edge.action.sections[0].rows[0], { title: x(24), description: x(72), id: x(200) })
  assert.equal((await send(edge)).status, 200)
  assert.equal(mock.calls.length, 3)
  assert.deepEqual(mock.calls[2].body.interactive, edge)
})

test('list: 11 rows (total across sections), 11 sections, long titles/description/label, missing section title → 400', async () => {
  await expectRefused(list([11]), 400, /at most 10 rows in total are allowed \(got 11\)/)
  await expectRefused(list([5, 6]), 400, /at most 10 rows in total are allowed \(got 11\)/)
  await expectRefused(list(Array(11).fill(1)), 400, /between 1 and 10 sections/)
  const t = list([1]); t.action.sections[0].rows[0].title = x(25)
  await expectRefused(t, 400, /title exceeds 24/)
  const d = list([1]); d.action.sections[0].rows[0].description = x(73)
  await expectRefused(d, 400, /description exceeds 72/)
  const l = list([1]); l.action.button = x(21)
  await expectRefused(l, 400, /action.button exceeds 20/)
  const s = list([1, 1]); delete s.action.sections[1].title
  await expectRefused(s, 400, /title is required when there are several sections/)
  const dup = list([2]); dup.action.sections[0].rows[1].id = 's0r0'
  await expectRefused(dup, 400, /duplicate row id/)
  await expectRefused(list([0]), 400, /at least one row/)
  const id = list([1]); id.action.sections[0].rows[0].id = x(201)
  await expectRefused(id, 400, /id exceeds 200/)
})

test('a single-section list may omit the section title (waCRM sends it that way when unset)', async () => {
  const l = list([2]); delete l.action.sections[0].title
  assert.equal((await send(l)).status, 200)
})

test('other interactive sub-types (cta_url, flow, product…) are not enabled: 501, SendZen not called', async () => {
  for (const type of ['cta_url', 'flow', 'product', 'product_list', 'location_request_message', undefined]) {
    await expectRefused({ type, body: { text: 'x' }, action: {} }, 501, /not enabled on this gateway/)
  }
})

test('test-kit payloads agree with the gateway: buttons3 and list10 pass, list11 (deliberate negative) is refused locally', async () => {
  for (const [name, status] of [['buttons3', 200], ['list10', 200], ['list3', 200], ['list11', 400]]) {
    const p = CASES[name]({ from: 'IGNORED', to: '15555550199' })
    assert.equal((await send(p.interactive)).status, status, name)
  }
  assert.equal(mock.calls.length, 3)
})

test('round trip (mock): a button_reply / list_reply built from what SendZen received carries back our ids, in Meta format', async () => {
  const sentButtons = await (await send(buttons(['Chauffeur', 'Transporteur']))).json()
  const sentList = await (await send(list([2]))).json()
  const tap = tapButton(mock.calls[0], sentButtons.messages[0].id, 1, { id: 'wamid.IN.1' })
  assert.deepEqual(tap.interactive, { type: 'button_reply', button_reply: { id: 'b1', title: 'Transporteur' } })
  assert.equal(tap.context.id, 'wamid.MOCK.1')
  const pick = chooseRow(mock.calls[1], sentList.messages[0].id, 0, 1, { id: 'wamid.IN.2' })
  assert.deepEqual(pick.interactive, { type: 'list_reply', list_reply: { id: 's0r1', title: 'Ville 0-1' } })
  const env = inboundEnvelope({ phoneNumberId: PNID, waId: '15555550199', message: tap })
  const value = env.entry[0].changes[0].value
  assert.equal(env.object, 'whatsapp_business_account')
  assert.equal(value.metadata.phone_number_id, PNID)
  assert.equal(value.messages[0].from, value.contacts[0].wa_id)
  assert.equal(value.messages[0].type, 'interactive')
})

test('validateInteractive is pure and total (never throws on garbage)', () => {
  for (const g of [null, undefined, 1, 'x', [], {}, { type: 'button' }, { type: 'list', body: { text: 'x' } }, { type: 'button', body: { text: 'x' }, action: { buttons: [null] } }]) {
    assert.equal(validateInteractive(g).ok, false)
  }
})
