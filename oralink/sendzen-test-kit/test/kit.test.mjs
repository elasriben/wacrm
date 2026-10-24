import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkSignatures, signatureVerdict, extractEvents, summarize, hmacHex } from '../analyze.mjs'
import { inboundEnvelope, inboundText, tapButton, chooseRow, signWebhook } from '../../sendzen-gateway/test/mock-sendzen.mjs'
import { CASES, assertSafeToSend, LIMITS } from '../payloads.mjs'

const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, messages: [{ id: 'wamid.A', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'test_driver', title: 'Chauffeur' } } }] } }] }] })

test('signature check recognises the documented scheme and rejects others', () => {
  const good = { 'x-hub-signature-256': `sha256=${hmacHex('s3cret', body)}` }
  assert.deepEqual(checkSignatures(good, body, ['other', 's3cret']), [{ header: 'x-hub-signature-256', secretIndex: 1, encoding: 'sha256=<hex>', ok: true, wacrmCompatible: true }])
  assert.equal(checkSignatures({ 'x-hub-signature-256': 'sha256=00' }, body, ['s3cret']).length, 0)
  // identifies a different encoding if the provider uses one
  const b64 = crypto.createHmac('sha256', 's3cret').update(body).digest('base64')
  assert.equal(checkSignatures({ 'x-signature': b64 }, body, ['s3cret'])[0].encoding, '<base64>')
  // a body modified after signing must not verify
  assert.equal(checkSignatures(good, body + ' ', ['s3cret']).length, 0)
})

test('events: button reply, list reply, template quick reply, status, STOP', () => {
  const mk = (m) => extractEvents({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1' }, messages: [m] } }] }] })[0]
  assert.deepEqual([mk({ id: 'a', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'Oui' } } })].map((e) => [e.kind, e.replyId]), [['interactive:button_reply', 'x']])
  assert.deepEqual([mk({ id: 'b', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'r1', title: 'Casa' } } })].map((e) => [e.kind, e.replyId]), [['interactive:list_reply', 'r1']])
  assert.deepEqual([mk({ id: 'c', type: 'button', button: { text: 'Oui', payload: 'P' }, context: { id: 'w' } })].map((e) => [e.kind, e.replyId, e.hasContext]), [['button', 'P', true]])
  for (const t of ['STOP', 'stop.', ' Arrêt ', 'UNSUBSCRIBE']) assert.equal(mk({ id: 'd', type: 'text', text: { body: t } }).looksLikeStop, true, t)
  assert.equal(mk({ id: 'e', type: 'text', text: { body: 'je ne veux pas arrêter de rouler' } }).looksLikeStop, false)
})

test('summary reports duplicates (retries) with their gaps and signature stats', () => {
  const rec = (t, ok) => ({ receivedAt: t, headers: { 'x-hub-signature-256': 'sha256=..' }, events: [{ kind: 'text', id: 'wamid.A' }], signature: ok ? [{ ok: true }] : [] })
  const s = summarize([rec('2026-01-01T00:00:00.000Z', true), rec('2026-01-01T00:00:05.000Z', true), rec('2026-01-01T00:00:35.000Z', false)])
  assert.equal(s.requests, 3); assert.equal(s.signatureVerified, 2); assert.equal(s.signatureUnverified, 1)
  assert.equal(s.signatureWacrmCompatible, 0) // records built without wacrmCompatible flags
  assert.deepEqual(s.signatureHeadersSeen, ['x-hub-signature-256'])
  assert.deepEqual(s.duplicates, [{ id: 'msg:wamid.A', deliveries: 3, gapsMs: [5000, 30000] }])
})

test('payloads respect WhatsApp limits; the 11-row list is the deliberate negative case', () => {
  const c = { from: 'F', to: 'T' }
  const b = CASES.buttons3(c).interactive.action.buttons
  assert.equal(b.length, LIMITS.maxButtons); assert.ok(b.every((x) => x.reply.title.length <= LIMITS.buttonTitle))
  assert.equal(CASES.list10(c).interactive.action.sections[0].rows.length, LIMITS.maxRows)
  assert.equal(CASES.list11(c).interactive.action.sections[0].rows.length, LIMITS.maxRows + 1)
  assert.ok(CASES.list10(c).interactive.action.sections[0].rows.every((r) => r.title.length <= LIMITS.rowTitle))
})

test('send guards: refuse production numbers, unlisted recipients, missing allow-lists', () => {
  const ok = { FROM: '+15555550110', TO: '+15555550111', TEST_FROM: '+15555550110', ALLOWED_TEST_RECIPIENTS: '+15555550111', PROTECTED_FROM: '+15555550100,+15555550101', SENDZEN_API_KEY: 'k' }
  assert.doesNotThrow(() => assertSafeToSend(ok))
  assert.throws(() => assertSafeToSend({ ...ok, FROM: '+15555550100', TEST_FROM: '+15555550100' }), /PROTECTED_FROM/)
  assert.throws(() => assertSafeToSend({ ...ok, TEST_FROM: '+15555550198' }), /TEST_FROM/)
  assert.throws(() => assertSafeToSend({ ...ok, TO: '+15555550197' }), /ALLOWED_TEST_RECIPIENTS/)
  assert.throws(() => assertSafeToSend({ ...ok, TEST_FROM: '', ALLOWED_TEST_RECIPIENTS: '' }), /explicitly/)
  assert.throws(() => assertSafeToSend({ ...ok, SENDZEN_API_KEY: '' }), /SENDZEN_API_KEY/)
})

const run = (script, args, env = {}) => new Promise((resolve) => {
  const p = spawn('node', [fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args], { env: { PATH: process.env.PATH, ...env } })
  let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
  p.on('close', (code) => resolve({ code, out, err }))
})

test('send-test.mjs is a dry run by default and refuses --send without allow-lists (no network)', async () => {
  const dry = await run('send-test.mjs', ['buttons3'], { FROM: 'F', TO: 'T' })
  assert.equal(dry.code, 0); assert.match(dry.out, /DRY RUN/)
  const refused = await run('send-test.mjs', ['text', '--send'], { FROM: 'F', TO: 'T', SENDZEN_API_KEY: 'k' })
  assert.equal(refused.code, 3); assert.match(refused.err, /REFUSED/)
})

test('replay refuses remote targets by default and never sends in dry-run', async () => {
  const r = await run('replay-to-wacrm.mjs', ['x.jsonl', '--url', 'https://crm.example.com/api/whatsapp/webhook'])
  assert.equal(r.code, 3); assert.match(r.err, /not an allowed local\/private/)
})

test('signature schemes: every plausible encoding is identified, and only one is waCRM-compatible', () => {
  const S = 'ci-dummy-webhook-secret'
  const h = (alg, data, enc) => crypto.createHmac(alg, S).update(data).digest(enc)
  const cases = [
    [{ 'x-hub-signature-256': `sha256=${h('sha256', body, 'hex')}` }, 'sha256=<hex>', 'compatible'],
    [{ 'x-hub-signature-256': h('sha256', body, 'hex') }, '<hex>', 'incompatible'],
    [{ 'x-hub-signature-256': `sha256=${h('sha256', body, 'hex').toUpperCase()}` }, 'sha256=<HEX>', 'incompatible'],
    [{ 'x-signature': h('sha256', body, 'base64') }, '<base64>', 'incompatible'],
    [{ 'x-hub-signature-256': `sha256=${h('sha256', body, 'base64')}` }, 'sha256=<base64>', 'incompatible'],
    [{ 'x-hub-signature': `sha1=${h('sha1', body, 'hex')}` }, 'sha1=<hex>', 'incompatible'],
    [{ 'x-sendzen-signature': h('sha256', `1760000000.${body}`, 'hex'), 'x-sendzen-timestamp': '1760000000' }, '<hex> of "<x-sendzen-timestamp>.<body>"', 'incompatible'],
    [{ 'x-webhook-signature': `t=1760000000,v1=${h('sha256', `1760000000.${body}`, 'hex')}` }, 't=<ts>,v1=<hex> of "<ts>.<body>"', 'incompatible'],
    // the right scheme but under another header name: waCRM only reads x-hub-signature-256
    [{ 'x-sendzen-hmac': `sha256=${h('sha256', body, 'hex')}` }, 'sha256=<hex>', 'incompatible'],
  ]
  for (const [headers, encoding, verdict] of cases) {
    const r = signatureVerdict(headers, body, ['other-secret', S])
    assert.equal(r.verdict, verdict, encoding)
    assert.ok(r.matches.some((m) => m.encoding === encoding && m.secretIndex === 1), encoding)
  }
  assert.equal(signatureVerdict({ 'x-hub-signature-256': 'sha256=00' }, body, [S]).verdict, 'unverified')
  assert.deepEqual(signatureVerdict({ 'content-type': 'application/json' }, body, [S]), { verdict: 'unsigned', matches: [], headersSeen: [] })
  // a wrong secret or a tampered body never matches any scheme
  assert.equal(signatureVerdict({ 'x-hub-signature-256': `sha256=${h('sha256', body, 'hex')}` }, body, ['nope']).verdict, 'unverified')
  assert.equal(signatureVerdict({ 'x-hub-signature-256': `sha256=${h('sha256', body, 'hex')}` }, body + ' ', [S]).verdict, 'unverified')
})

test('mock inbound webhooks (Meta format) are parsed by the kit: text keyword, button_reply, list_reply, signature', () => {
  const call = { body: { from: '+15555550100', interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'tz_driver', title: 'Chauffeur' } }] } } } }
  const lcall = { body: { from: '+15555550100', interactive: { type: 'list', action: { sections: [{ rows: [{ id: 'city_casa', title: 'Casablanca', description: 'Grand Casa' }] }] } } } }
  const mk = (message) => inboundEnvelope({ phoneNumberId: '111111111111111', waId: '15555550199', message })
  const [t] = extractEvents(mk(inboundText({ id: 'wamid.IN.1', text: 'OL-TZ-BF1' })))
  assert.deepEqual([t.kind, t.id, t.phoneNumberId, t.looksLikeStop], ['text', 'wamid.IN.1', '111111111111111', false])
  const [b] = extractEvents(mk(tapButton(call, 'wamid.OUT.1', 0, { id: 'wamid.IN.2' })))
  assert.deepEqual([b.kind, b.replyId, b.hasContext], ['interactive:button_reply', 'tz_driver', true])
  const [l] = extractEvents(mk(chooseRow(lcall, 'wamid.OUT.2', 0, 0, { id: 'wamid.IN.3' })))
  assert.deepEqual([l.kind, l.replyId], ['interactive:list_reply', 'city_casa'])
  const raw = JSON.stringify(mk(inboundText({ id: 'wamid.IN.4', text: 'x' })))
  assert.equal(signatureVerdict({ 'x-hub-signature-256': signWebhook('ci-dummy-s', raw) }, raw, ['ci-dummy-s']).verdict, 'compatible')
})
