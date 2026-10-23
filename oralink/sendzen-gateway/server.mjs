// PROTOTYPE — waCRM ⇄ SendZen gateway ("voie Z′").
//
// waCRM keeps calling the Graph API shape (POST {base}/{phoneNumberId}/messages, Bearer token).
// This service translates ONLY what has been established, forwards the Bearer token to SendZen
// untouched (the gateway stores no key), and answers HONESTLY about everything else:
// unsupported or unverified operations return an explicit Meta-style error (HTTP 501) — never a
// fabricated success. See DESIGN.md and docs/oralink/sendzen/contract.md for the call-by-call
// contract and what is still unverified.
//
// Internal http only: the gateway listens on a private Docker network / loopback and is NEVER
// exposed publicly (the Bearer token crosses this hop in clear text) — CONTRACTS §2.
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { validateInteractive } from './interactive-limits.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** The only message types the contract allows (CONTRACTS §7). ALLOW_TYPES may narrow, never widen. */
export const CONTRACT_TYPES = Object.freeze(['text', 'interactive'])
/** WhatsApp text body limit (Meta Cloud API documentation: 4096 characters). */
export const TEXT_BODY_MAX = 4096
/** Upper bound on what the gateway reads back from SendZen. */
export const MAX_UPSTREAM_BYTES = 65536

/** Meta-shaped error body, which is what waCRM's throwMetaError() understands. */
function metaError(message, { type = 'GatewayError', code = 1, status, traceId, details } = {}) {
  return { status, body: { error: { message, type, code, fbtrace_id: traceId ?? 'oralink-gw', ...(typeof details === 'string' && details ? { error_data: { details } } : {}) } } }
}
const notImplemented = (message, note) => [metaError(message, { type: 'GatewayNotImplemented', code: 501, status: 501 }), note]
const invalidParam = (reason, note) => [metaError(`(#131009) Parameter value is not valid: ${reason}`, { type: 'GatewayValidationError', code: 131009, status: 400 }), note]

function intEnv(env, name, fallback, min, max) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return n
}

export function loadConfig(env = process.env) {
  const sendzenBase = (env.SENDZEN_API_BASE || 'https://api.sendzen.io').replace(/\/+$/, '')
  let u
  try { u = new URL(sendzenBase) } catch { throw new Error('SENDZEN_API_BASE must be a valid URL') }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) {
    throw new Error('SENDZEN_API_BASE must be https (http only for loopback tests)')
  }
  if (u.username || u.password || u.search || u.hash) throw new Error('SENDZEN_API_BASE must not contain credentials, query or fragment')
  let numberMap = {}
  try { numberMap = JSON.parse(env.NUMBER_MAP || '{}') } catch { throw new Error('NUMBER_MAP must be valid JSON') }
  if (!numberMap || typeof numberMap !== 'object' || Array.isArray(numberMap)) throw new Error('NUMBER_MAP must be a JSON object')
  for (const [id, v] of Object.entries(numberMap)) {
    if (!/^\d{5,20}$/.test(id)) throw new Error(`NUMBER_MAP key "${id}" must be a numeric phone_number_id`)
    if (!v || typeof v.from !== 'string' || !v.from) throw new Error(`NUMBER_MAP["${id}"].from is required`)
  }
  const allowTypes = new Set((env.ALLOW_TYPES || CONTRACT_TYPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean))
  for (const t of allowTypes) {
    if (!CONTRACT_TYPES.includes(t)) throw new Error(`ALLOW_TYPES may only contain ${CONTRACT_TYPES.join(', ')} (got "${t}"): other types are not verified through SendZen`)
  }
  return {
    sendzenBase,
    numberMap,
    allowTypes,
    maxBodyBytes: intEnv(env, 'MAX_BODY_BYTES', 262144, 1024, 1048576),
    timeoutMs: intEnv(env, 'SENDZEN_TIMEOUT_MS', 15000, 100, 60000),
    port: intEnv(env, 'PORT', 8080, 0, 65535),
    host: env.HOST || '127.0.0.1',
  }
}

/** Read at most `max` bytes. Returns null when the body is larger (the caller answers 413). */
async function readBody(req, max) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) return null
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError) }
    // On overflow: stop buffering, pause the stream (no destroy, so the 413 can still be written;
    // the response carries `connection: close`).
    const onData = (c) => { size += c.length; if (size > max) { cleanup(); req.pause(); resolve(null) } else chunks.push(c) }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')) }
    const onError = (e) => { cleanup(); reject(e) }
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError)
  })
}

/** Read an upstream response body with a hard size cap. Returns null when it is larger. */
async function readUpstream(response, max) {
  if (!response.body) return ''
  const chunks = []; let size = 0
  for await (const c of response.body) {
    size += c.length
    if (size > max) { await response.body.cancel?.().catch(() => {}); return null }
    chunks.push(Buffer.from(c))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Route shape for the logs: never a raw path segment (it may carry an id or a phone number).
const KNOWN_SEGMENTS = new Set(['messages', 'register', 'subscribed_apps', 'phone_numbers', 'message_templates', 'healthz'])
function routeShape(parts) {
  if (parts.length === 1 && parts[0] === 'healthz') return '/healthz'
  return '/' + parts.map((p, i) => (i > 0 && KNOWN_SEGMENTS.has(p) ? p : ':id')).join('/')
}

const NOT_IMPLEMENTED = {
  config: 'Phone-number lookups, registration and WABA subscription are not performed through this gateway: the number is provisioned out-of-band (SendZen dashboard + provisioning script). No Meta verification took place.',
  templates: 'Template management and sync are not implemented in this prototype (SendZen template endpoints not yet verified).',
  media: 'Media retrieval is not implemented in this prototype (SendZen inbound-media access not documented).',
  generic: 'This operation is not implemented by the SendZen gateway.',
}

/** Translate one Graph send request. Returns [response, note]. */
async function handleSend(req, parts, config, doFetch) {
  const phoneNumberId = parts[0]
  const auth = req.headers['authorization']
  if (typeof auth !== 'string' || !/^Bearer [^\s]{1,4096}$/.test(auth)) return [metaError('Missing or malformed Bearer token', { type: 'OAuthException', code: 190, status: 401 }), 'no-auth']
  const entry = Object.hasOwn(config.numberMap, phoneNumberId) ? config.numberMap[phoneNumberId] : undefined
  if (!entry) return [metaError('Unknown phone number id for this gateway', { type: 'GraphMethodException', code: 100, status: 404 }), 'unknown-number']

  const raw = await readBody(req, config.maxBodyBytes)
  if (raw === null) return [metaError('Payload too large', { code: 100, status: 413 }), 'too-large']
  let body
  try { body = JSON.parse(raw) } catch { return [metaError('Invalid JSON', { code: 100, status: 400 }), 'bad-json'] }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [metaError('Invalid body', { code: 100, status: 400 }), 'bad-body']

  if (body.status === 'read') return notImplemented(NOT_IMPLEMENTED.generic + ' (read receipts / typing indicator)', 'read-receipt')
  if (!config.allowTypes.has(body.type)) {
    const type = typeof body.type === 'string' ? body.type.slice(0, 40) : String(body.type)
    return notImplemented(`Message type "${type}" is not enabled on this gateway (allowed: ${[...config.allowTypes].join(', ')}). ${body.type === 'template' ? NOT_IMPLEMENTED.templates : NOT_IMPLEMENTED.generic}`, 'type-not-enabled')
  }
  if (typeof body.to !== 'string' || !body.to) return [metaError('Only phone-number recipients ("to") are supported; username/BSUID recipients are not.', { type: 'GatewayNotImplemented', code: 100, status: 400 }), 'no-to']
  if (!/^\+?\d{6,20}$/.test(body.to)) return invalidParam('"to" must be a phone number (digits, optional leading +)', 'bad-to')

  if (body.type === 'text') {
    const t = body.text
    if (!t || typeof t !== 'object' || typeof t.body !== 'string' || !t.body.trim()) return invalidParam('text.body is required', 'text-invalid')
    if ([...t.body].length > TEXT_BODY_MAX) return invalidParam(`text.body exceeds ${TEXT_BODY_MAX} characters`, 'text-invalid')
  }
  // Interactive: only reply buttons (<= 3) and lists (<= 10 rows), within WhatsApp's length limits.
  // Invalid payloads are refused HERE (400, Meta-style 131009) so SendZen is never asked to send
  // something WhatsApp is known to reject; other sub-types / media headers are unverified (501).
  if (body.type === 'interactive') {
    const v = validateInteractive(body.interactive)
    if (!v.ok) return v.unsupported ? notImplemented(v.reason, 'interactive-unsupported') : invalidParam(v.reason, 'interactive-invalid')
  }
  let context
  if (body.context !== undefined) {
    if (!body.context || typeof body.context.message_id !== 'string' || !body.context.message_id || body.context.message_id.length > 256) return invalidParam('context.message_id must be a non-empty string', 'context-invalid')
    context = { message_id: body.context.message_id }
  }

  // Meta body -> SendZen body. Built field by field (allow-list): only what waCRM sends for these
  // types is forwarded; `from` comes from NUMBER_MAP and can never be overridden by the request.
  // Interactive LIST and `context` pass-through are NOT confirmed by SendZen (contract.md ❓).
  const outbound = { from: entry.from, to: body.to, type: body.type, [body.type]: body[body.type], ...(context ? { context } : {}) }

  let upstream, text
  try {
    upstream = await doFetch(`${config.sendzenBase}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(outbound),
      redirect: 'error', // never follow a redirect with the Bearer token
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    text = await readUpstream(upstream, MAX_UPSTREAM_BYTES)
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return [metaError(timeout ? 'SendZen did not answer in time' : 'SendZen unreachable', { code: 2, status: timeout ? 504 : 502 }), timeout ? 'timeout' : 'unreachable']
  }
  const trace = upstream.headers.get('x-request-id')?.slice(0, 128) ?? undefined
  if (text === null) return [metaError('SendZen response too large', { code: 2, status: 502, traceId: trace }), 'upstream-too-large']
  let data = null
  try { data = JSON.parse(text) } catch { /* handled below */ }

  if (!upstream.ok) {
    const e = data?.error ?? {}
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502
    return [metaError(typeof e.message === 'string' ? e.message.slice(0, 1000) : `SendZen error ${upstream.status}`, { type: 'SendZenError', code: Number.isFinite(Number(e.code)) ? Number(e.code) : 1, status, traceId: trace, details: typeof e.details === 'string' ? e.details.slice(0, 1000) : undefined }), 'upstream-error']
  }
  const id = data?.message_id ?? data?.messages?.[0]?.id
  if (typeof id !== 'string' || !id) return [metaError('Unexpected SendZen response: no message id', { code: 2, status: 502, traceId: trace }), 'bad-upstream']
  // Only what SendZen actually returned: the message id. `contacts[].wa_id` is NOT fabricated.
  return [{ status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: body.to }], messages: [{ id }] } }, 'sent']
}

export function createGateway(config, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch
  const log = deps.log ?? ((line) => console.log(line))

  const server = http.createServer(async (req, res) => {
    const started = Date.now()
    let parts = []
    const done = ([r, note = '']) => {
      if (res.headersSent) return
      const headers = r.status === 413 ? { ...JSON_HEADERS, connection: 'close' } : JSON_HEADERS
      res.writeHead(r.status, headers); res.end(JSON.stringify(r.body))
      // Never log Authorization, bodies, ids or phone numbers: only method, route shape, status, latency.
      log(JSON.stringify({ m: req.method, route: routeShape(parts), status: r.status, ms: Date.now() - started, note }))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://gateway.local')
      parts = url.pathname.split('/').filter(Boolean)
      if (/^v\d+\.\d+$/.test(parts[0] ?? '')) parts.shift() // version segment is ignored

      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'healthz') return done([{ status: 200, body: { ok: true } }])
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'messages') return done(await handleSend(req, parts, config, doFetch))

      // ---- Everything else: honest 501 ----
      const last = parts[parts.length - 1] ?? ''
      if (last === 'message_templates') return done(notImplemented(NOT_IMPLEMENTED.templates, 'templates'))
      if (last === 'subscribed_apps' || last === 'phone_numbers' || last === 'register' || (req.method === 'GET' && parts.length === 1 && url.searchParams.has('fields'))) {
        return done(notImplemented(NOT_IMPLEMENTED.config, 'config'))
      }
      if (req.method === 'GET' && parts.length === 1) return done(notImplemented(NOT_IMPLEMENTED.media, 'media'))
      return done(notImplemented(NOT_IMPLEMENTED.generic, 'generic'))
    } catch {
      // Never crash the process and never leak the error (it may quote request content).
      return done([metaError('Internal gateway error', { code: 1, status: 500 }), 'internal'])
    }
  })
  // Bounded request lifetime (slow clients).
  server.headersTimeout = 10_000
  server.requestTimeout = Math.max(30_000, config.timeoutMs + 10_000)
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig()
  createGateway(config).listen(config.port, config.host, () => console.log(`sendzen-gateway listening on ${config.host}:${config.port} (numbers: ${Object.keys(config.numberMap).length})`))
}
