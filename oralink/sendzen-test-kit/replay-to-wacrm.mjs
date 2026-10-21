#!/usr/bin/env node
// Replays captured webhook bodies to a waCRM webhook with a freshly computed X-Hub-Signature-256.
//   node replay-to-wacrm.mjs captures/capture-XXX.jsonl                 -> DRY RUN (lists what would be sent)
//   REPLAY_SECRET=... node replay-to-wacrm.mjs <file> --send [--url http://127.0.0.1:3000/api/whatsapp/webhook]
// REPLAY_SECRET must equal the META_APP_SECRET of the target waCRM. Only loopback / private targets are allowed
// unless --allow-remote is given. Use a STAGING waCRM with a test database — never production.
import fs from 'node:fs'
import { hmacHex } from './analyze.mjs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const urlIdx = args.indexOf('--url')
const url = urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:3000/api/whatsapp/webhook'
if (!file) { console.error('Usage: replay-to-wacrm.mjs <capture.jsonl> [--send] [--url U] [--allow-remote]'); process.exit(2) }
const host = new URL(url).hostname
const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(host)
if (!local && !args.includes('--allow-remote')) { console.error(`REFUSED: ${host} is not local/private (use --allow-remote deliberately)`); process.exit(3) }
const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.rawBody)
console.log(`${records.length} captured request(s) -> ${url}${args.includes('--send') ? '' : '  (DRY RUN)'}`)
for (const r of records) {
  const label = r.events.map((e) => e.kind).join(',') || '-'
  if (!args.includes('--send')) { console.log('  would send:', label); continue }
  if (!process.env.REPLAY_SECRET) { console.error('REPLAY_SECRET is required for --send'); process.exit(2) }
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacHex(process.env.REPLAY_SECRET, r.rawBody)}` }, body: r.rawBody })
  console.log(`  ${res.status}  ${label}`)
}
