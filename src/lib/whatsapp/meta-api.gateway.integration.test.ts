// Integration: REAL waCRM send code -> REAL Z′ gateway -> MOCK SendZen (a stand-in built from the
// documented request/response shapes; it does not prove real SendZen behaviour — see
// oralink/sendzen-test-kit/TEST-PLAN.md for the tests that do).
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const gwDir = resolve(process.cwd(), 'oralink/sendzen-gateway')
const load = (f: string) => import(/* @vite-ignore */ pathToFileURL(resolve(gwDir, f)).href)

type Closable = { close: (cb?: () => void) => void; closeAllConnections?: () => void }
const closeIt = (s: Closable) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.() })

let mock: { calls: Array<{ url: string; auth: string; body: Record<string, unknown> }>; base: string; server: Closable }
let gateway: Closable & { address: () => { port: number } }
let api: typeof import('./meta-api')

beforeAll(async () => {
  const { startMockSendzen } = await load('test/mock-sendzen.mjs')
  const { createGateway, loadConfig } = await load('server.mjs')
  mock = await startMockSendzen()
  gateway = createGateway(
    loadConfig({ SENDZEN_API_BASE: mock.base, NUMBER_MAP: JSON.stringify({ '111111111111111': { from: '+212600000001' } }) }),
    { log: () => {} },
  )
  await new Promise<void>((r) => (gateway as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', r))
  vi.resetModules()
  vi.stubEnv('WHATSAPP_API_BASE_URL', `http://127.0.0.1:${gateway.address().port}/v21.0`)
  api = await import('./meta-api')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await closeIt(gateway)
  await closeIt(mock.server)
})

describe('waCRM -> Z′ gateway -> (mock) SendZen', () => {
  const common = { phoneNumberId: '111111111111111', accessToken: 'sz_test_token', to: '212600000099' }

  it('text, reply buttons and list go through the unmodified waCRM send functions', async () => {
    const t = await api.sendTextMessage({ ...common, text: 'Bonjour' })
    const b = await api.sendInteractiveButtons({ ...common, bodyText: 'Vous êtes ?', buttons: [{ id: 'drv', title: 'Chauffeur' }, { id: 'car', title: 'Transporteur' }] })
    const l = await api.sendInteractiveList({
      ...common, bodyText: 'Votre ville ?', buttonLabel: 'Choisir',
      sections: [{ title: 'Villes', rows: [{ id: 'casa', title: 'Casablanca' }, { id: 'rabat', title: 'Rabat' }] }],
    })
    expect([t.messageId, b.messageId, l.messageId]).toEqual(['wamid.MOCK1', 'wamid.MOCK1', 'wamid.MOCK1'])
    expect(mock.calls.map((c) => c.url)).toEqual(['/v1/messages', '/v1/messages', '/v1/messages'])
    expect(mock.calls.every((c) => c.auth === 'Bearer sz_test_token')).toBe(true)
    expect(mock.calls.every((c) => c.body.from === '+212600000001' && !('messaging_product' in c.body))).toBe(true)
    expect(mock.calls[1].body).toMatchObject({ type: 'interactive', interactive: { type: 'button' } })
    expect(mock.calls[2].body).toMatchObject({ type: 'interactive', interactive: { type: 'list' } })
  })

  it('unsupported operations surface as real errors in waCRM (no fake success)', async () => {
    await expect(api.verifyPhoneNumber({ phoneNumberId: '111111111111111', accessToken: 'sz_test_token' })).rejects.toThrow(/No Meta verification took place|provisioned out-of-band/)
    const before = mock.calls.length
    await expect(api.sendTemplateMessage({ ...common, templateName: 'x', language: 'fr' })).rejects.toThrow(/not enabled on this gateway/)
    expect(mock.calls.length).toBe(before) // SendZen was never called
  })
})
