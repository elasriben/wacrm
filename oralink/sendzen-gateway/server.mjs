// PROTOTYPE — waCRM ⇄ SendZen gateway ("voie Z′").
//
// waCRM keeps calling the Graph API shape (POST {base}/{phoneNumberId}/messages, Bearer token).
// This service translates ONLY what has been established, forwards the Bearer token to SendZen
// untouched (the gateway stores no key), and answers HONESTLY about everything else:
// unsupported or unverified operations return an explicit Meta-style error (HTTP 501) — never a
// fabricated success. See DESIGN.md for the call-by-call table and what is still unverified.
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** Meta-shaped error body, which is what waCRM's throwMetaError() understands. */
function metaError(message, { type = 'GatewayError', code = 1, status, traceId, details } = {}) {
  return { status, body: { error: { message, type, code, fbtrace_id: traceId ?? 'oralink-gw', ...(details ? { error_data: { details } } : {}) } } }
}

export function loadConfig(env = process.env) {
  const sendzenBase = (env.SENDZEN_API_BASE || 'https://api.sendzen.io').replace(/\/+$/, '')
  const u = new URL(sendzenBase)
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error('SENDZEN_API_BASE must be https (http only for loopback tests)')
  }
  let numberMap = {}
  try { numberMap = JSON.parse(env.NUMBER_MAP || '{}') } catch { throw new Error('NUMBER_MAP must be valid JSON') }
  for (const [id, v] of Object.entries(numberMap)) {
    if (!/^\d{5,20}$/.test(id)) throw new Error(`NUMBER_MAP key "${id}" must be a numeric phone_number_id`)
    if (!v || typeof v.from !== 'string' || !v.from) throw new Error(`NUMBER_MAP["${id}"].from is required`)
  }
  return {
    sendzenBase,
    numberMap,
    // Types forwarded to SendZen. Everything else answers 501 until verified (templates, media, reactions…).
    allowTypes: new Set((env.ALLOW_TYPES || 'text,interactive').split(',').map((s) => s.trim()).filter(Boolean)),
    maxBodyBytes: Number(env.MAX_BODY_BYTES || 262144),
    timeoutMs: Number(env.SENDZEN_TIMEOUT_MS || 15000),
    port: Number(env.PORT || 8080),
    host: env.HOST || '127.0.0.1',
  }
}

async function readBody(req, max) {
  const chunks = []; let size = 0
  for await (const c of req) { size += c.length; if (size > max) return null; chunks.push(c) }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res, { status, body }) {
  res.writeHead(status, JSON_HEADERS); res.end(JSON.stringify(body))
}

const NOT_IMPLEMENTED = {
  config: 'Phone-number lookups, registration and WABA subscription are not performed through this gateway: the number is provisioned out-of-band (SendZen dashboard + provisioning script). No Meta verification took place.',
  templates: 'Template management and sync are not implemented in this prototype (SendZen template endpoints not yet verified).',
  media: 'Media retrieval is not implemented in this prototype (SendZen inbound-media access not documented).',
  generic: 'This operation is not implemented by the SendZen gateway.',
}

export function createGateway(config, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch
  const log = deps.log ?? ((line) => console.log(line))

  return http.createServer(async (req, res) => {
    const started = Date.now()
    const url = new URL(req.url ?? '/', 'http://gateway.local')
    const parts = url.pathname.split('/').filter(Boolean)
    if (/^v\d+\.\d+$/.test(parts[0] ?? '')) parts.shift() // version segment is ignored
    const done = (r, note = '') => {
      send(res, r)
      // Never log Authorization, bodies or phone numbers: only method, route shape, status, latency.
      log(JSON.stringify({ m: req.method, route: parts.length === 2 ? `/:id/${parts[1]}` : `/${parts.length} segments`, status: r.status, ms: Date.now() - started, note }))
    }

    if (req.method === 'GET' && url.pathname === '/healthz') return done({ status: 200, body: { ok: true } })

    // ---- POST /{phoneNumberId}/messages -> SendZen POST /v1/messages ----
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'messages') {
      const phoneNumberId = parts[0]
      const auth = req.headers['authorization']
      if (!auth || !/^Bearer\s+\S+$/.test(auth)) return done(metaError('Missing or malformed Bearer token', { type: 'OAuthException', code: 190, status: 401 }))
      const entry = config.numberMap[phoneNumberId]
      if (!entry) return done(metaError('Unknown phone number id for this gateway', { type: 'GraphMethodException', code: 100, status: 404 }), 'unknown-number')

      const raw = await readBody(req, config.maxBodyBytes)
      if (raw === null) return done(metaError('Payload too large', { code: 100, status: 413 }))
      let body
      try { body = JSON.parse(raw) } catch { return done(metaError('Invalid JSON', { code: 100, status: 400 })) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return done(metaError('Invalid body', { code: 100, status: 400 }))

      if (body.status === 'read') return done(metaError(NOT_IMPLEMENTED.generic + ' (read receipts / typing indicator)', { type: 'GatewayNotImplemented', code: 501, status: 501 }))
      if (typeof body.to !== 'string' || !body.to) return done(metaError('Only phone-number recipients ("to") are supported; username/BSUID recipients are not.', { type: 'GatewayNotImplemented', code: 100, status: 400 }))
      if (!config.allowTypes.has(body.type)) {
        return done(metaError(`Message type "${body.type}" is not enabled on this gateway (allowed: ${[...config.allowTypes].join(', ')}). ${body.type === 'template' ? NOT_IMPLEMENTED.templates : NOT_IMPLEMENTED.generic}`, { type: 'GatewayNotImplemented', code: 501, status: 501 }))
      }

      // Meta body -> SendZen body: drop the Meta-only discriminator, add the sender.
      // Every other field is forwarded unchanged (SendZen documents Meta-shaped session messages).
      // Interactive LIST and `context` pass-through are NOT yet confirmed by SendZen documentation.
      const outbound = { from: entry.from, ...body }
      delete outbound.messaging_product
      delete outbound.recipient_type

      let upstream
      try {
        upstream = await doFetch(`${config.sendzenBase}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: auth },
          body: JSON.stringify(outbound),
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch (e) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        return done(metaError(timeout ? 'SendZen did not answer in time' : 'SendZen unreachable', { code: 2, status: timeout ? 504 : 502 }), timeout ? 'timeout' : 'unreachable')
      }
      const text = await upstream.text()
      let data = null
      try { data = JSON.parse(text) } catch { /* handled below */ }
      const trace = upstream.headers.get('x-request-id') ?? undefined

      if (!upstream.ok) {
        const e = data?.error ?? {}
        return done(metaError(typeof e.message === 'string' ? e.message : `SendZen error ${upstream.status}`, { type: 'SendZenError', code: Number.isFinite(Number(e.code)) ? Number(e.code) : 1, status: upstream.status, traceId: trace, details: e.details }), 'upstream-error')
      }
      const id = data?.message_id ?? data?.messages?.[0]?.id
      if (typeof id !== 'string' || !id) {
        return done(metaError('Unexpected SendZen response: no message id', { code: 2, status: 502, traceId: trace }), 'bad-upstream')
      }
      return done({ status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id }] } })
    }

    // ---- Everything else: honest 501 / 404 ----
    const last = parts[parts.length - 1] ?? ''
    if (last === 'message_templates') return done(metaError(NOT_IMPLEMENTED.templates, { type: 'GatewayNotImplemented', code: 501, status: 501 }))
    if (last === 'subscribed_apps' || last === 'phone_numbers' || last === 'register' || (req.method === 'GET' && parts.length === 1 && url.searchParams.has('fields'))) {
      return done(metaError(NOT_IMPLEMENTED.config, { type: 'GatewayNotImplemented', code: 501, status: 501 }))
    }
    if (req.method === 'GET' && parts.length === 1) return done(metaError(NOT_IMPLEMENTED.media, { type: 'GatewayNotImplemented', code: 501, status: 501 }))
    return done(metaError(NOT_IMPLEMENTED.generic, { type: 'GatewayNotImplemented', code: 501, status: 501 }))
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig()
  createGateway(config).listen(config.port, config.host, () => console.log(`sendzen-gateway listening on ${config.host}:${config.port} (numbers: ${Object.keys(config.numberMap).length})`))
}
