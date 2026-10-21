import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { checkSignatures, extractEvents, summarize, hmacHex } from '../analyze.mjs'
import { CASES, assertSafeToSend, LIMITS } from '../payloads.mjs'

const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, messages: [{ id: 'wamid.A', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'test_driver', title: 'Chauffeur' } } }] } }] }] })

test('signature check recognises the documented scheme and rejects others', () => {
  const good = { 'x-hub-signature-256': `sha256=${hmacHex('s3cret', body)}` }
  assert.deepEqual(checkSignatures(good, body, ['other', 's3cret']), [{ header: 'x-hub-signature-256', secretIndex: 1, encoding: 'sha256=<hex>', ok: true }])
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
  const ok = { FROM: '+212600000010', TO: '+212600000011', TEST_FROM: '+212600000010', ALLOWED_TEST_RECIPIENTS: '+212600000011', PROTECTED_FROM: '+212600000001,+212600000002', SENDZEN_API_KEY: 'k' }
  assert.doesNotThrow(() => assertSafeToSend(ok))
  assert.throws(() => assertSafeToSend({ ...ok, FROM: '+212600000001', TEST_FROM: '+212600000001' }), /PROTECTED_FROM/)
  assert.throws(() => assertSafeToSend({ ...ok, TEST_FROM: '+212600000099' }), /TEST_FROM/)
  assert.throws(() => assertSafeToSend({ ...ok, TO: '+212611111111' }), /ALLOWED_TEST_RECIPIENTS/)
  assert.throws(() => assertSafeToSend({ ...ok, TEST_FROM: '', ALLOWED_TEST_RECIPIENTS: '' }), /explicitly/)
  assert.throws(() => assertSafeToSend({ ...ok, SENDZEN_API_KEY: '' }), /SENDZEN_API_KEY/)
})

const run = (script, args, env = {}) => new Promise((resolve) => {
  const p = spawn('node', [new URL(`../${script}`, import.meta.url).pathname, ...args], { env: { PATH: process.env.PATH, ...env } })
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
  assert.equal(r.code, 3); assert.match(r.err, /not local\/private/)
})
