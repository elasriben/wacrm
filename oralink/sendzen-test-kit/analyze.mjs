// Pure analysis helpers for captured SendZen webhooks (no network, no secrets stored).
import crypto from 'node:crypto'

const SIG_HEADER_RE = /sign|hmac|hub/i

export function hmacHex(secret, raw) { return crypto.createHmac('sha256', secret).update(raw).digest('hex') }
function safeEq(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y) }

/** For every signature-looking header and every candidate secret, test the plausible encodings. */
export function checkSignatures(headers, rawBody, secrets) {
  const out = []
  for (const [name, value] of Object.entries(headers)) {
    if (!SIG_HEADER_RE.test(name) || typeof value !== 'string') continue
    for (let i = 0; i < secrets.length; i++) {
      const hex = hmacHex(secrets[i], rawBody)
      const b64 = crypto.createHmac('sha256', secrets[i]).update(rawBody).digest('base64')
      const forms = { 'sha256=<hex>': `sha256=${hex}`, '<hex>': hex, 'sha256=<base64>': `sha256=${b64}`, '<base64>': b64 }
      for (const [form, expected] of Object.entries(forms)) {
        if (safeEq(value, expected)) out.push({ header: name, secretIndex: i, encoding: form, ok: true })
      }
    }
  }
  return out
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
  const sigHeaders = new Set(); let verified = 0
  for (const r of records) {
    for (const h of Object.keys(r.headers ?? {})) if (SIG_HEADER_RE.test(h)) sigHeaders.add(h)
    if (r.signature?.some((s) => s.ok)) verified++
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
    kinds: Object.fromEntries([...records.flatMap((r) => (r.events ?? []).map((e) => e.kind))].reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map())),
    stopLike: records.flatMap((r) => r.events ?? []).filter((e) => e.looksLikeStop).length,
    duplicates,
  }
}
