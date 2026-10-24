export const MAX_WEBHOOK_BODY_BYTES = 4 * 1024 * 1024

/**
 * Read the request body as the EXACT bytes received, capped at `maxBytes`
 * (declared Content-Length first, then the streamed size). Returns null
 * when the cap is exceeded. The webhook HMAC must be computed over these
 * bytes: decoding to a string first is lossy for invalid UTF-8 (every bad
 * sequence becomes U+FFFD), so two different bodies could share a
 * signature check.
 */
export async function readCappedBodyBytes(
  request: Request,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<Buffer | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return Buffer.alloc(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Kept for compatibility: same limits, body decoded as (lenient) UTF-8.
 * Do not use it for signature verification — see readCappedBodyBytes.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<string | null> {
  const bytes = await readCappedBodyBytes(request, maxBytes)
  return bytes === null ? null : bytes.toString('utf8')
}
