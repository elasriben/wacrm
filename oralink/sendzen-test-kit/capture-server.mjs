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
import { pathToFileURL } from 'node:url'
import { MAX_BODY_BYTES, MAX_CAPTURE_BYTES } from './capture-format.mjs'
import { checkSignatures, extractEvents, summarize } from './analyze.mjs'

export function createCaptureServer({ file, token, secrets = [], failures = 0 }) {
  const records = []
  let storedBytes = 0
  let failNext = failures

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (req.method === 'GET' && url.pathname === '/__summary') {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(403); return res.end() }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(summarize(records), null, 2))
      }
      if (req.method !== 'POST' || url.pathname !== `/hook/${token}`) { res.writeHead(404); return res.end() }
      const chunks = []; let size = 0
      for await (const c of req) { size += c.length; if (size > MAX_BODY_BYTES) { res.writeHead(413); return res.end() } chunks.push(c) }
      const bytes = Buffer.concat(chunks)
      let raw = null
      try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { /* preserve invalid UTF-8 as base64 */ }
      let parsed = null; try { parsed = JSON.parse(raw ?? '') } catch { /* keep raw */ }
      const rec = { receivedAt: new Date().toISOString(), method: req.method, headers: req.headers, rawBody: raw, rawBodyBase64: bytes.toString('base64'), events: (() => { try { return extractEvents(parsed) } catch { return [] } })(), signature: checkSignatures(req.headers, bytes, secrets), respondedWith: 200 }
      if (failNext > 0) { failNext--; rec.respondedWith = 500 }
      const line = JSON.stringify(rec) + '\n'
      if (records.length >= 1000 || storedBytes + Buffer.byteLength(line) > MAX_CAPTURE_BYTES) { res.writeHead(413); return res.end() }
      fs.appendFileSync(file, line); storedBytes += Buffer.byteLength(line); records.push(rec)
      console.log(`${rec.receivedAt} ${rec.respondedWith} events=${rec.events.map((e) => e.kind).join(',') || '-'} sig=${rec.signature.length ? (rec.signature.some((s) => s.wacrmCompatible) ? 'VERIFIED-WACRM-COMPATIBLE(' : 'VERIFIED-BUT-WACRM-INCOMPATIBLE(') + rec.signature.map((s) => `${s.header}:${s.encoding}`).join(';') + ')' : secrets.length ? 'NOT-VERIFIED' : 'no-secret-configured'}`)
      res.writeHead(rec.respondedWith, { 'content-type': 'application/json' }); res.end(rec.respondedWith === 200 ? '{"ok":true}' : '{"ok":false}')
    } catch { if (!res.headersSent) res.writeHead(500); res.end() }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const HOST = process.env.HOST || '127.0.0.1'
  const PORT = Number(process.env.PORT || 8787)
  const SECRETS = (process.env.SENDZEN_WEBHOOK_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean)
  const failNext = Number(process.env.FAIL_NEXT || 0)
  const TOKEN = process.env.PATH_TOKEN || crypto.randomBytes(12).toString('hex')
  const dir = path.resolve('captures'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  fs.writeFileSync(file, '', { mode: 0o600 })
  const server = createCaptureServer({ file, token: TOKEN, secrets: SECRETS, failures: failNext })
  server.listen(PORT, HOST, () => {
    console.log(`capture-server on http://${HOST}:${PORT}/hook/${TOKEN}`)
    console.log(`  secrets configured: ${SECRETS.length} · FAIL_NEXT=${failNext} · file: ${file}`)
    console.log(`  summary: curl -s http://127.0.0.1:${PORT}/__summary`)
  })
}
