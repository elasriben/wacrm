#!/usr/bin/env node
// Explicit test destinations only. See TEST-PLAN.md; never replay to production.
import fs from 'node:fs'
import { isIP } from 'node:net'
import { pathToFileURL } from 'node:url'
import { hmacHex } from './analyze.mjs'
import { MAX_CAPTURE_BYTES, parseCaptures } from './capture-format.mjs'

function privateIPv4(host) {
  if (isIP(host) !== 4) return false
  const [a, b] = host.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
export function replayDestination(input, allowedHosts = []) {
  if (typeof input !== 'string' || /[\s\\%]/.test(input) || !/^https?:\/\//.test(input)) throw new Error('REFUSED: malformed destination')
  const url = new URL(input)
  const authority = input.match(/^https?:\/\/([^/?#]+)/)?.[1]
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/api/whatsapp/webhook' || url.port === '0') throw new Error('REFUSED: invalid destination URL')
  // Reject URL parser normalization of integer/hex/octal IPs, credentials and trailing dots.
  const canonical = url.host
  const defaultPort = url.protocol === 'http:' ? ':80' : ':443'
  if (authority !== canonical && authority !== canonical + defaultPort) throw new Error('REFUSED: noncanonical host')
  const host = url.hostname
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !(allowedHosts.includes(host) && privateIPv4(host))) throw new Error('REFUSED: destination is not an allowed local/private literal')
  // localhost must never be resolved through DNS/proxy configuration.
  if (host === 'localhost') url.hostname = '127.0.0.1'
  return url
}
export async function replay(args, env = process.env) {
  let file; let input = 'http://127.0.0.1:3000/api/whatsapp/webhook'; let send = false
  const allowed = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--send') send = true
    else if (arg === '--url' || arg === '--allow-host') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error('REFUSED: missing option value')
      if (arg === '--url') input = value
      else { if (!privateIPv4(value)) throw new Error('REFUSED: allow-host requires a private IPv4 literal'); allowed.push(value) }
    } else if (arg.startsWith('--') || file) throw new Error('REFUSED: unknown argument')
    else file = arg
  }
  const url = replayDestination(input, allowed)
  if (!file) throw new Error('capture file required')
  if (fs.statSync(file).size > MAX_CAPTURE_BYTES) throw new Error('capture file too large')
  // Validate the ENTIRE file before the first request; never silently drop a record.
  const captures = parseCaptures(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file)))
  if (send && !env.REPLAY_SECRET) throw new Error('REPLAY_SECRET is required for --send')
  console.log(`${captures.length} captured request(s) -> ${url}${send ? '' : ' (DRY RUN)'}`)
  for (const { record, bytes } of captures) {
    const label = record.events.map((e) => e.kind).join(',') || '-'
    if (!send) { console.log('  would send:', label); continue }
    const res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacHex(env.REPLAY_SECRET, bytes)}` }, body: bytes })
    await res.body?.cancel()
    if (!res.ok) throw new Error(`replay failed: HTTP ${res.status}`)
    console.log(`  ${res.status} ${label}`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  replay(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = error.message.startsWith('REFUSED:') ? 3 : 2 })
}
