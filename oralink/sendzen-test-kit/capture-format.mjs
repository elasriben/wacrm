// Captures are test data, not trusted input. Base64 preserves even invalid UTF-8.
export const MAX_BODY_BYTES = 1_000_000
export const MAX_CAPTURE_BYTES = 16_000_000
export function captureBytes(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid capture record')
  let bytes
  if (Object.hasOwn(record, 'rawBodyBase64')) {
    const b64 = record.rawBodyBase64
    if (typeof b64 !== 'string' || b64.length > Math.ceil(MAX_BODY_BYTES / 3) * 4) throw new Error('invalid capture base64')
    bytes = Buffer.from(b64, 'base64')
    if (bytes.toString('base64') !== b64) throw new Error('invalid capture base64')
    if (record.rawBody != null && (typeof record.rawBody !== 'string' || !Buffer.from(record.rawBody).equals(bytes))) throw new Error('capture body mismatch')
  } else {
    if (typeof record.rawBody !== 'string') throw new Error('capture rawBody required')
    bytes = Buffer.from(record.rawBody, 'utf8')
    if (bytes.toString('utf8') !== record.rawBody) throw new Error('lossy capture body')
  }
  if (!bytes.length || bytes.length > MAX_BODY_BYTES) throw new Error('invalid capture body size')
  if (!Array.isArray(record.events) || record.events.some((e) => !e || typeof e.kind !== 'string')) throw new Error('invalid capture events')
  return bytes
}
export function parseCaptures(text) {
  if (Buffer.byteLength(text) > MAX_CAPTURE_BYTES) throw new Error('capture file too large')
  const lines = text.split('\n').filter((s) => s.trim())
  if (!lines.length) throw new Error('capture file is empty')
  return lines.map((line, i) => {
    try { const record = JSON.parse(line); return { record, bytes: captureBytes(record) } }
    catch { throw new Error(`invalid capture at line ${i + 1}`) }
  })
}
