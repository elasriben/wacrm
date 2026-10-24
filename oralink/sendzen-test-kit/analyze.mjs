// Pure analysis helpers for captured SendZen webhooks (no network, no secrets stored).
import crypto from 'node:crypto'

const SIG_HEADER_RE = /sign|hmac|hub/i

export function hmacHex(secret, raw) { return crypto.createHmac('sha256', secret).update(raw).digest('hex') }
function safeEq(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y) }

/** The only scheme waCRM's verifier accepts (src/lib/whatsapp/webhook-signature.ts). */
export const WACRM_SCHEME = Object.freeze({ header: 'x-hub-signature-256', encoding: 'sha256=<hex>' })

const TS_HEADER_RE = /timestamp|^x-.*-ts$/i

/**
 * For every signature-looking header and every candidate secret, test the plausible schemes:
 * HMAC-SHA256 hex/HEX/base64, with or without "sha256=", HMAC-SHA1 ("sha1=<hex>", legacy
 * X-Hub-Signature), and timestamped variants (HMAC over "<ts>.<body>" when a timestamp header is
 * present; Stripe-like "t=<ts>,v1=<hex>"). Each match says whether waCRM would accept it as is.
 */
export function checkSignatures(headers, rawBody, secrets) {
  const out = []
  const tsHeader = Object.entries(headers).find(([n, v]) => TS_HEADER_RE.test(n) && typeof v === 'string')
  for (const [name, value] of Object.entries(headers)) {
    if (!SIG_HEADER_RE.test(name) || typeof value !== 'string') continue
    for (let i = 0; i < secrets.length; i++) {
      const h256 = (data, enc) => crypto.createHmac('sha256', secrets[i]).update(data).digest(enc)
      const hex = h256(rawBody, 'hex')
      const b64 = h256(rawBody, 'base64')
      const forms = {
        'sha256=<hex>': `sha256=${hex}`, '<hex>': hex, 'sha256=<HEX>': `sha256=${hex.toUpperCase()}`, '<HEX>': hex.toUpperCase(),
        'sha256=<base64>': `sha256=${b64}`, '<base64>': b64,
        'sha1=<hex>': `sha1=${crypto.createHmac('sha1', secrets[i]).update(rawBody).digest('hex')}`,
      }
      if (tsHeader) {
        const signed = Buffer.concat([Buffer.from(`${tsHeader[1]}.`), Buffer.from(rawBody)])
        forms[`<hex> of "<${tsHeader[0]}>.<body>"`] = h256(signed, 'hex')
        forms[`sha256=<hex> of "<${tsHeader[0]}>.<body>"`] = `sha256=${h256(signed, 'hex')}`
        forms[`<base64> of "<${tsHeader[0]}>.<body>"`] = h256(signed, 'base64')
      }
      const stripe = /^t=(\d+),v1=([0-9a-f]+)$/.exec(value)
      if (stripe) forms['t=<ts>,v1=<hex> of "<ts>.<body>"'] = `t=${stripe[1]},v1=${h256(Buffer.concat([Buffer.from(`${stripe[1]}.`), Buffer.from(rawBody)]), 'hex')}`
      for (const [form, expected] of Object.entries(forms)) {
        if (safeEq(value, expected)) out.push({ header: name, secretIndex: i, encoding: form, ok: true, wacrmCompatible: name.toLowerCase() === WACRM_SCHEME.header && form === WACRM_SCHEME.encoding })
      }
    }
  }
  return out
}

/**
 * One-line verdict for T-S1. `compatible`: waCRM accepts it unchanged. `incompatible`: SendZen signs,
 * but with a scheme waCRM rejects (waCRM change needed — CRM agent). `unverified`: a signature header
 * exists but no scheme/secret matched. `unsigned`: no signature-looking header at all.
 */
export function signatureVerdict(headers, rawBody, secrets) {
  const matches = checkSignatures(headers, rawBody, secrets)
  if (matches.some((m) => m.wacrmCompatible)) return { verdict: 'compatible', matches }
  if (matches.length) return { verdict: 'incompatible', matches }
  const seen = Object.keys(headers).filter((h) => SIG_HEADER_RE.test(h))
  return { verdict: seen.length ? 'unverified' : 'unsigned', matches, headersSeen: seen }
}

export function extractEvents(parsed) {
  const events = []
  for (const entry of parsed?.entry ?? []) for (const ch of entry.changes ?? []) {
    const v = ch.value ?? {}
    const phoneNumberId = v.metadata?.phone_number_id
    for (const m of v.messages ?? []) {
      const kind = m.type === 'interactive' ? `interactive:${m.interactive?.type}` : m.type
      const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title
      const replyId = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload
      events.push({ kind, id: m.id, phoneNumberId, replyId, looksLikeStop: /^\s*(stop|arr[eê]t|arret|unsubscribe|désinscri\w*)\s*[.!]*\s*$/i.test(text ?? ''), hasContext: Boolean(m.context) })
    }
    for (const s of v.statuses ?? []) events.push({ kind: `status:${s.status}`, id: s.id, phoneNumberId })
    if (ch.field && ch.field !== 'messages') events.push({ kind: `field:${ch.field}`, id: undefined, phoneNumberId })
  }
  return events
}

export function summarize(records) {
  const byId = new Map()
  const sigHeaders = new Set(); let verified = 0; let compatible = 0
  for (const r of records) {
    for (const h of Object.keys(r.headers ?? {})) if (SIG_HEADER_RE.test(h)) sigHeaders.add(h)
    if (r.signature?.some((s) => s.ok)) verified++
    if (r.signature?.some((s) => s.wacrmCompatible)) compatible++
    for (const e of r.events ?? []) {
      if (!e.id) continue
      const k = `${e.kind.startsWith('status') ? e.kind : 'msg'}:${e.id}`
      const list = byId.get(k) ?? []; list.push(r.receivedAt); byId.set(k, list)
    }
  }
  const duplicates = [...byId.entries()].filter(([, v]) => v.length > 1).map(([id, times]) => ({ id, deliveries: times.length, gapsMs: times.slice(1).map((t, i) => Date.parse(t) - Date.parse(times[i])) }))
  return {
    requests: records.length,
    signatureHeadersSeen: [...sigHeaders],
    signatureVerified: verified,
    signatureUnverified: records.length - verified,
    signatureWacrmCompatible: compatible,
    signatureEncodings: [...new Set(records.flatMap((r) => (r.signature ?? []).map((s) => `${s.header}:${s.encoding}`)))],
    kinds: Object.fromEntries([...records.flatMap((r) => (r.events ?? []).map((e) => e.kind))].reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map())),
    stopLike: records.flatMap((r) => r.events ?? []).filter((e) => e.looksLikeStop).length,
    duplicates,
  }
}
