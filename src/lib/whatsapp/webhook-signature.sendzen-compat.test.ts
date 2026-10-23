// If SendZen signs as it announced (header X-Hub-Signature-256, HMAC-SHA256, "sha256=<hex>" over the raw
// body, using the webhook "secret"), waCRM's existing verifier accepts it when that secret is listed in
// META_APP_SECRET (comma-separated list supported). This test covers waCRM's side ONLY; whether SendZen
// really signs this way is established by oralink/sendzen-test-kit (TEST-PLAN T-S1).
import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, messages: [] } }] }] })
const sign = (secret: string, body: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')

async function verifier(secrets: string) {
  vi.resetModules(); vi.stubEnv('META_APP_SECRET', secrets)
  return (await import('./webhook-signature')).verifyMetaWebhookSignature
}
afterEach(() => vi.unstubAllEnvs())

describe('waCRM accepts the announced SendZen signature scheme', () => {
  it('accepts a valid signature made with any of several configured secrets (TranZit + Immerview webhooks)', async () => {
    const verify = await verifier('sendzen-secret-tranzit, sendzen-secret-immerview')
    expect(verify(raw, sign('sendzen-secret-tranzit', raw))).toBe(true)
    expect(verify(raw, sign('sendzen-secret-immerview', raw))).toBe(true)
  })
  it('rejects wrong secret, tampered body, missing header, wrong prefix and bare hex', async () => {
    const verify = await verifier('sendzen-secret-tranzit')
    expect(verify(raw, sign('someone-else', raw))).toBe(false)
    expect(verify(raw + ' ', sign('sendzen-secret-tranzit', raw))).toBe(false)
    expect(verify(raw, null)).toBe(false)
    expect(verify(raw, sign('sendzen-secret-tranzit', raw).replace('sha256=', 'sha1='))).toBe(false)
    expect(verify(raw, sign('sendzen-secret-tranzit', raw).slice(7))).toBe(false)
  })
})
