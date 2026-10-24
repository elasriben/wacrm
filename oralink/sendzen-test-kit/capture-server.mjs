#!/usr/bin/env node
// Throwaway SendZen webhook receiver for the contract tests (TEST-PLAN.md).
// - Binds to 127.0.0.1 by default. Exposing it to the Internet (tunnel) is YOUR decision and must be
//   temporary; the random path token below is the only access control.
// - Stores raw headers + body of a DEDICATED TEST number in ./captures (mode 600, git-ignored).
// - Never forwards anything anywhere. Responds 200, or 500 for the first FAIL_NEXT requests (retry test).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { checkSignatures, extractEvents, summarize } from './analyze.mjs'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8787)
const SECRETS = (process.env.SENDZEN_WEBHOOK_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean)
let failNext = Number(process.env.FAIL_NEXT || 0)
const TOKEN = process.env.PATH_TOKEN || crypto.randomBytes(12).toString('hex')
const dir = path.resolve('captures'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const file = path.join(dir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
fs.writeFileSync(file, '', { mode: 0o600 })
const records = []

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'GET' && url.pathname === '/__summary') {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(403); return res.end() }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(summarize(records), null, 2))
  }
  if (req.method !== 'POST' || url.pathname !== `/hook/${TOKEN}`) { res.writeHead(404); return res.end() }
  const chunks = []; let size = 0
  for await (const c of req) { size += c.length; if (size > 1_000_000) { res.writeHead(413); return res.end() } chunks.push(c) }
  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed = null; try { parsed = JSON.parse(raw) } catch { /* keep raw */ }
  const rec = { receivedAt: new Date().toISOString(), method: req.method, headers: req.headers, rawBody: raw, events: extractEvents(parsed), signature: checkSignatures(req.headers, raw, SECRETS), respondedWith: 200 }
  if (failNext > 0) { failNext--; rec.respondedWith = 500 }
  records.push(rec); fs.appendFileSync(file, JSON.stringify(rec) + '\n')
  console.log(`${rec.receivedAt} ${rec.respondedWith} events=${rec.events.map((e) => e.kind).join(',') || '-'} sig=${rec.signature.length ? (rec.signature.some((s) => s.wacrmCompatible) ? 'VERIFIED-WACRM-COMPATIBLE(' : 'VERIFIED-BUT-WACRM-INCOMPATIBLE(') + rec.signature.map((s) => `${s.header}:${s.encoding}`).join(';') + ')' : SECRETS.length ? 'NOT-VERIFIED' : 'no-secret-configured'}`)
  res.writeHead(rec.respondedWith, { 'content-type': 'application/json' }); res.end(rec.respondedWith === 200 ? '{"ok":true}' : '{"ok":false}')
})
server.listen(PORT, HOST, () => {
  console.log(`capture-server on http://${HOST}:${PORT}/hook/${TOKEN}`)
  console.log(`  secrets configured: ${SECRETS.length} · FAIL_NEXT=${failNext} · file: ${file}`)
  console.log(`  summary: curl -s http://127.0.0.1:${PORT}/__summary`)
})
