#!/usr/bin/env node
// Sends TEST messages through the SendZen API from a DEDICATED test number to an allow-listed test phone.
//   node send-test.mjs buttons3            -> DRY RUN: prints the payload, sends nothing
//   node send-test.mjs buttons3 --send     -> real send (all guards must pass)
// Configuration is read from the environment only (see .env.example). The API key is never printed.
import { CASES, assertSafeToSend } from './payloads.mjs'

const [caseName, ...flags] = process.argv.slice(2)
if (!CASES[caseName]) { console.error(`Usage: send-test.mjs <${Object.keys(CASES).join('|')}> [--send]`); process.exit(2) }
const env = process.env
const payload = CASES[caseName]({ from: env.FROM || '<FROM>', to: env.TO || '<TO>' })

if (!flags.includes('--send')) {
  console.log('DRY RUN — nothing sent. Payload:'); console.log(JSON.stringify(payload, null, 2)); process.exit(0)
}
try { assertSafeToSend(env) } catch (e) { console.error('REFUSED:', e.message); process.exit(3) }
const base = (env.SENDZEN_API_BASE || 'https://api.sendzen.io').replace(/\/+$/, '')
const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SENDZEN_API_KEY}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) })
const body = await res.text()
console.log(JSON.stringify({ case: caseName, status: res.status, requestId: res.headers.get('x-request-id'), body: (() => { try { return JSON.parse(body) } catch { return body.slice(0, 500) } })() }, null, 2))
