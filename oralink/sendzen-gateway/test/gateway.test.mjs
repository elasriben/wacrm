import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createGateway, loadConfig } from '../server.mjs'
import { startMockSendzen } from './mock-sendzen.mjs'

const closeServer = (s) => new Promise((resolve) => { const t = setTimeout(resolve, 1000); t.unref(); s.close(() => resolve()); s.closeAllConnections?.() })

const TOKEN = 'sz_test_SECRET_TOKEN_123'
let mock, gw, base, logs, handler
const NUMBER_MAP = JSON.stringify({ '111111111111111': { from: '+15555550100', label: 'tranzit-test' }, '222222222222222': { from: '+15555550101', label: 'immerview-test' } })

before(async () => {
  mock = await startMockSendzen((c) => handler(c))
})
after(async () => {
  if (gw) await closeServer(gw)
  await closeServer(mock.server)
})
beforeEach(async () => {
  mock.calls.length = 0
  handler = () => ({ status: 202, json: { message_id: 'wamid.MOCK1', status: 'accepted', timestamp: '1' } })
  logs = []
  if (gw) await closeServer(gw)
  gw = createGateway(loadConfig({ SENDZEN_API_BASE: mock.base, NUMBER_MAP, SENDZEN_TIMEOUT_MS: '300', MAX_BODY_BYTES: '2000' }), { log: (l) => logs.push(l) })
  await new Promise((r) => gw.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${gw.address().port}`
})

const post = (path, body, headers = { authorization: `Bearer ${TOKEN}` }) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

const text = { messaging_product: 'whatsapp', to: '15555550199', type: 'text', text: { body: 'Bonjour' } }

test('text: translated to POST /v1/messages with from, without messaging_product; Bearer forwarded untouched', async () => {
  const r = await post('/v21.0/111111111111111/messages', text)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { messaging_product: 'whatsapp', contacts: [{ input: '15555550199' }], messages: [{ id: 'wamid.MOCK1' }] })
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0].url, '/v1/messages')
  assert.equal(mock.calls[0].auth, `Bearer ${TOKEN}`)
  assert.deepEqual(mock.calls[0].body, { from: '+15555550100', to: '15555550199', type: 'text', text: { body: 'Bonjour' } })
})

test('multi-number routing: each phone_number_id maps to its own sender', async () => {
  await post('/v21.0/111111111111111/messages', text)
  await post('/v21.0/222222222222222/messages', text)
  assert.deepEqual(mock.calls.map((c) => c.body.from), ['+15555550100', '+15555550101'])
})

test('unknown phone_number_id: 404 and SendZen is never called', async () => {
  const r = await post('/v21.0/999999999999999/messages', text)
  assert.equal(r.status, 404)
  assert.equal(mock.calls.length, 0)
})

test('reply buttons keep the Meta/SendZen interactive structure', async () => {
  const interactive = { type: 'button', body: { text: 'Vous êtes ?' }, action: { buttons: [{ type: 'reply', reply: { id: 'drv', title: 'Chauffeur' } }, { type: 'reply', reply: { id: 'car', title: 'Transporteur' } }] } }
  const r = await post('/v21.0/111111111111111/messages', { messaging_product: 'whatsapp', to: '15555550199', type: 'interactive', interactive })
  assert.equal(r.status, 200)
  assert.deepEqual(mock.calls[0].body.interactive, interactive)
  assert.equal(mock.calls[0].body.type, 'interactive')
})

test('list is forwarded as-is (NOT yet confirmed by SendZen docs — see TEST-PLAN T-S4)', async () => {
  const interactive = { type: 'list', body: { text: 'Choisir' }, action: { button: 'Voir', sections: [{ title: 'S', rows: [{ id: 'r1', title: 'A' }] }] } }
  const r = await post('/v21.0/111111111111111/messages', { messaging_product: 'whatsapp', to: '15555550199', type: 'interactive', interactive })
  assert.equal(r.status, 200)
  assert.deepEqual(mock.calls[0].body.interactive, interactive)
})

test('missing Bearer token: 401 Meta-style error, SendZen not called', async () => {
  const r = await post('/v21.0/111111111111111/messages', text, {})
  assert.equal(r.status, 401)
  assert.equal((await r.json()).error.code, 190)
  assert.equal(mock.calls.length, 0)
})

test('templates, media, reactions, read receipts: honest 501, never a fake success, SendZen not called', async () => {
  for (const b of [
    { messaging_product: 'whatsapp', to: '1', type: 'template', template: { name: 'x', language: { code: 'fr' } } },
    { messaging_product: 'whatsapp', to: '1', type: 'image', image: { link: 'https://x/y.jpg' } },
    { messaging_product: 'whatsapp', to: '1', type: 'reaction', reaction: { message_id: 'w', emoji: '👍' } },
    { messaging_product: 'whatsapp', status: 'read', message_id: 'w' },
  ]) {
    const r = await post('/v21.0/111111111111111/messages', b)
    assert.equal(r.status, 501, JSON.stringify(b).slice(0, 40))
    assert.equal((await r.json()).error.type, 'GatewayNotImplemented')
  }
  assert.equal(mock.calls.length, 0)
})

test('Meta configuration calls are NOT simulated: 501 with an explicit message', async () => {
  const calls = [
    ['GET', '/v21.0/111111111111111?fields=id,display_phone_number,verified_name,quality_rating'],
    ['POST', '/v21.0/111111111111111/register'],
    ['POST', '/v21.0/WABA123/subscribed_apps'],
    ['GET', '/v21.0/WABA123/subscribed_apps'],
    ['GET', '/v21.0/WABA123/phone_numbers?fields=id'],
  ]
  for (const [method, path] of calls) {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}` }, body: method === 'POST' ? '{}' : undefined })
    assert.equal(r.status, 501, `${method} ${path}`)
    const e = (await r.json()).error
    assert.match(e.message, /No Meta verification took place|provisioned out-of-band/)
  }
})

test('template management and media lookups: 501', async () => {
  for (const [method, path] of [['GET', '/v21.0/WABA123/message_templates?limit=100'], ['POST', '/v21.0/WABA123/message_templates'], ['DELETE', '/v21.0/WABA123/message_templates?name=x'], ['GET', '/v21.0/MEDIA123']]) {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}` }, body: method === 'POST' ? '{}' : undefined })
    assert.equal(r.status, 501, `${method} ${path}`)
  }
})

test('username/BSUID recipients are refused explicitly', async () => {
  const r = await post('/v21.0/111111111111111/messages', { messaging_product: 'whatsapp', recipient: 'BSUID.abc', type: 'text', text: { body: 'x' } })
  assert.equal(r.status, 400)
  assert.equal(mock.calls.length, 0)
})

test('SendZen error is surfaced with its status, message and request id (not masked as success)', async () => {
  handler = () => ({ status: 400, json: { error: { code: 4001, message: 'Invalid recipient', details: 'to must be E.164' } } })
  const r = await post('/v21.0/111111111111111/messages', text)
  assert.equal(r.status, 400)
  const e = (await r.json()).error
  assert.equal(e.message, 'Invalid recipient'); assert.equal(e.code, 4001); assert.equal(e.type, 'SendZenError'); assert.equal(e.fbtrace_id, 'req-mock-1')
})

test('SendZen 202 without a message id: 502, not a fabricated id', async () => {
  handler = () => ({ status: 202, json: { status: 'accepted' } })
  const r = await post('/v21.0/111111111111111/messages', text)
  assert.equal(r.status, 502)
})

test('SendZen returning non-JSON: 502', async () => {
  handler = () => ({ status: 200, raw: '<html>oops</html>' })
  assert.equal((await post('/v21.0/111111111111111/messages', text)).status, 502)
})

test('SendZen timeout: 504', async () => {
  handler = () => ({ hang: true })
  assert.equal((await post('/v21.0/111111111111111/messages', text)).status, 504)
})

test('oversized body: 413 before any upstream call', async () => {
  const r = await post('/v21.0/111111111111111/messages', { ...text, text: { body: 'x'.repeat(5000) } })
  assert.equal(r.status, 413)
  assert.equal(mock.calls.length, 0)
})

test('logs never contain the token, message text or phone numbers', async () => {
  await post('/v21.0/111111111111111/messages', text)
  const all = logs.join('\n')
  assert.ok(logs.length > 0)
  for (const secret of [TOKEN, 'Bonjour', '15555550199', '+15555550100']) assert.ok(!all.includes(secret), `log leaked ${secret}`)
})

test('config validation: invalid NUMBER_MAP / non-https SendZen base are rejected at startup', () => {
  assert.throws(() => loadConfig({ NUMBER_MAP: '{bad' }), /valid JSON/)
  assert.throws(() => loadConfig({ NUMBER_MAP: '{"abc":{"from":"x"}}' }), /numeric/)
  assert.throws(() => loadConfig({ NUMBER_MAP: '{"12345678":{}}' }), /from is required/)
  assert.throws(() => loadConfig({ SENDZEN_API_BASE: 'http://api.sendzen.example' }), /https/)
})

