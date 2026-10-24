import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { replay, replayDestination } from '../replay-to-wacrm.mjs'
import { parseCaptures, captureBytes, MAX_BODY_BYTES } from '../capture-format.mjs'
import { createCaptureServer } from '../capture-server.mjs'
import { hmacHex, signatureVerdict } from '../analyze.mjs'
const script = fileURLToPath(new URL('../replay-to-wacrm.mjs', import.meta.url))
const record = { rawBody: '{}', events: [] }
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendzen-p0-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
async function listen(t, server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r) }))
  return `http://127.0.0.1:${server.address().port}`
}
for (const authority of ['localhost.attacker.invalid', '10.attacker.invalid', '127.0.0.1.attacker.invalid', 'localhost.', '2130706433', '0x7f000001', '127.1', '0177.0.0.1', 'user:pass@127.0.0.1', '127.0.0.1\\@evil.invalid', '%31%32%37.0.0.1', '[::ffff:127.0.0.1]', '169.254.169.254', '10.0.0.1']) {
  test(`destination refuses ${authority}`, () => assert.throws(() => replayDestination(`http://${authority}/api/whatsapp/webhook`)))
}
for (const url of ['not a URL', 'file:///api/whatsapp/webhook', 'http://127.0.0.1/other', 'http://127.0.0.1/api/whatsapp/webhook#x', 'http://127.0.0.1/api/whatsapp/webhook?x=1']) test(`destination refuses ${url}`, () => assert.throws(() => replayDestination(url)))
test('only exact loopback and opted-in private IP literals are allowed', () => {
  assert.equal(replayDestination('http://localhost:3000/api/whatsapp/webhook').hostname, '127.0.0.1')
  assert.equal(replayDestination('http://[::1]/api/whatsapp/webhook').hostname, '[::1]')
  assert.equal(replayDestination('https://10.1.2.3/api/whatsapp/webhook', ['10.1.2.3']).hostname, '10.1.2.3')
  assert.throws(() => replayDestination('https://evil.invalid/api/whatsapp/webhook', ['evil.invalid']))
})
for (const invalid of ['', '\n', '{}\n', '{bad}\n', JSON.stringify({ rawBody: '', events: [] }), JSON.stringify({ rawBody: 123, events: [] }), JSON.stringify({ rawBody: '\ud800', events: [] }), JSON.stringify({ rawBody: '{}', events: 'bad' }), JSON.stringify({ rawBodyBase64: '!!!', events: [] }), JSON.stringify({ rawBody: 'different', rawBodyBase64: 'e30=', events: [] })]) {
  test(`invalid capture fails CLI: ${JSON.stringify(invalid)}`, (t) => {
    const file = path.join(temp(t), 'capture.jsonl'); fs.writeFileSync(file, invalid)
    assert.throws(() => parseCaptures(invalid))
    const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' })
    assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /0 captured/)
  })
}
test('missing file and blanket remote override fail closed', () => {
  for (const args of [['/nonexistent/capture.jsonl'], ['/nonexistent/capture.jsonl', '--allow-remote']]) assert.notEqual(spawnSync(process.execPath, [script, ...args]).status, 0)
})
test('invalid record after valid prefix sends nothing', async (t) => {
  let calls = 0
  const base = await listen(t, http.createServer((_q, r) => { calls++; r.end() }))
  const file = path.join(temp(t), 'capture.jsonl'); fs.writeFileSync(file, JSON.stringify(record) + '\n{}\n')
  await assert.rejects(replay([file, '--send', '--url', base + '/api/whatsapp/webhook'], { REPLAY_SECRET: 'simulated-secret' }), /invalid capture/)
  assert.equal(calls, 0)
})
test('all redirects and HTTP errors fail; signed captures never reach redirected target', async (t) => {
  let forwarded = 0
  const target = await listen(t, http.createServer((_q, r) => { forwarded++; r.end() }))
  let status = 302
  const base = await listen(t, http.createServer((_q, r) => { r.writeHead(status, { location: target + '/api/whatsapp/webhook' }); r.end() }))
  const file = path.join(temp(t), 'capture.jsonl'); fs.writeFileSync(file, JSON.stringify(record))
  for (const code of [301, 302, 303, 307, 308, 500]) {
    status = code
    await assert.rejects(replay([file, '--send', '--url', base + '/api/whatsapp/webhook'], { REPLAY_SECRET: 'simulated-secret' }))
  }
  assert.equal(forwarded, 0)
})
test('simulated HMAC checks exact invalid UTF-8 bytes and rejects altered bodies', () => {
  const bytes = Buffer.from([0xff, 0x61]); const secret = 'simulated-only'
  const headers = { 'x-hub-signature-256': `sha256=${hmacHex(secret, bytes)}` }
  assert.equal(signatureVerdict(headers, bytes, [secret]).verdict, 'compatible')
  assert.equal(signatureVerdict(headers, Buffer.from([0xfe, 0x61]), [secret]).verdict, 'unverified')
  assert.equal(signatureVerdict(headers, Buffer.from(bytes.toString('utf8')), [secret]).verdict, 'unverified')
  const signed = Buffer.concat([Buffer.from('123.'), bytes])
  assert.equal(signatureVerdict({ 'x-timestamp': '123', 'x-signature': hmacHex(secret, signed) }, bytes, [secret]).verdict, 'incompatible')
})
test('receiver preserves invalid UTF-8 and replay signs and sends original bytes', async (t) => {
  const file = path.join(temp(t), 'capture.jsonl'); fs.writeFileSync(file, '')
  const secret = 'simulated-only'; const bytes = Buffer.from([0xff, 0x61])
  const base = await listen(t, createCaptureServer({ file, token: 'test', secrets: [secret] }))
  const headers = { 'x-hub-signature-256': `sha256=${hmacHex(secret, bytes)}` }
  const response = await fetch(base + '/hook/test', { method: 'POST', headers, body: bytes }); assert.equal(response.status, 200); await response.text()
  const captured = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(captured.rawBody, null)
  assert.deepEqual(captureBytes(captured), bytes); assert.equal(captured.signature[0].wacrmCompatible, true)
  let received = false
  const target = await listen(t, http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), bytes); assert.equal(req.headers['x-hub-signature-256'], headers['x-hub-signature-256']); received = true; res.end('ok')
  }))
  await replay([file, '--send', '--url', target + '/api/whatsapp/webhook'], { REPLAY_SECRET: secret }); assert.equal(received, true)
})
test('receiver enforces body cap and fails storage errors without crashing on malformed events', async (t) => {
  const file = path.join(temp(t), 'capture.jsonl'); fs.writeFileSync(file, '')
  const base = await listen(t, createCaptureServer({ file, token: 'test' }))
  let r = await fetch(base + '/hook/test', { method: 'POST', body: Buffer.alloc(MAX_BODY_BYTES + 1) }); assert.equal(r.status, 413); await r.text()
  assert.equal(fs.readFileSync(file, 'utf8'), '')
  r = await fetch(base + '/hook/test', { method: 'POST', body: '{"entry":123}' }); assert.equal(r.status, 200); await r.text()
  fs.unlinkSync(file); fs.mkdirSync(file)
  r = await fetch(base + '/hook/test', { method: 'POST', body: '{}' }); assert.equal(r.status, 500); await r.text()
})

test('invalid UTF-8 in JSONL cannot be silently replaced and accepted', (t) => {
  const file = path.join(temp(t), 'capture.jsonl')
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"rawBody":"'), Buffer.from([0xff]), Buffer.from('","events":[]}')]))
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
})
test('body size and base64 agreement validation cannot be bypassed', () => {
  assert.throws(() => captureBytes({ rawBody: 'x'.repeat(MAX_BODY_BYTES + 1), events: [] }), /size/)
  assert.throws(() => captureBytes({ rawBodyBase64: 'e30', events: [] }), /base64/)
  assert.deepEqual(captureBytes({ rawBody: '{}', events: [] }), Buffer.from('{}'))
})
test('receiver preserves UTF-8 BOM and marks a modified signed body unverified', async (t) => {
  const file = path.join(temp(t), 'capture.jsonl'); fs.writeFileSync(file, '')
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]); const secret = 'simulated-only'
  const base = await listen(t, createCaptureServer({ file, token: 'test', secrets: [secret] }))
  const headers = { 'x-hub-signature-256': `sha256=${hmacHex(secret, bytes)}` }
  for (const body of [bytes, Buffer.concat([bytes, Buffer.from(' ')])]) {
    const r = await fetch(base + '/hook/test', { method: 'POST', headers, body }); assert.equal(r.status, 200); await r.text()
  }
  const captures = parseCaptures(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(captures[0].bytes, bytes)
  assert.equal(captures[0].record.signature[0].wacrmCompatible, true)
  assert.deepEqual(captures[1].record.signature, [])
})
