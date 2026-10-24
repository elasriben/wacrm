// MAQUETTE (MOCK) — SendZen is SIMULATED (oralink/sendzen-gateway/test/mock-sendzen.mjs).
// The REAL send functions of waCRM (the ones src/lib/flows/meta-send.ts calls) with
// WHATSAPP_API_BASE_URL pointing at the REAL Z′ gateway, itself pointing at the MOCK SendZen — all on
// 127.0.0.1, port 0. Asserts the exact request SendZen would receive. Proves the translation chain,
// NOT how the real SendZen behaves (TEST-PLAN T-S3 / T-S4 / T-S5).
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type Call = { method: string; url: string; auth: string; body: Row }
type Closable = { close: (cb?: () => void) => void; closeAllConnections?: () => void }
type Listening = Closable & { listen: (p: number, host: string, cb: () => void) => void; address: () => { port: number } }
type Reply = { status?: number; json?: unknown; raw?: string; hang?: boolean }

const load = (f: string) => import(/* @vite-ignore */ pathToFileURL(resolve(process.cwd(), 'oralink', f)).href)
const closeIt = (s: Closable) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.() })

const PNID = '111111111111111'
const KEY = 'sz_ci_dummy_key_tranzit'
const TO = '15555550199'
let mock: { calls: Call[]; base: string; server: Closable }
let gateway: Listening
let api: typeof import('./meta-api')
let seq = 0
let next: (() => Reply) | null = null

beforeAll(async () => {
  const { startMockSendzen } = await load('sendzen-gateway/test/mock-sendzen.mjs')
  const { createGateway, loadConfig } = await load('sendzen-gateway/server.mjs')
  mock = await startMockSendzen(() => (next ? next() : { status: 202, json: { message_id: `wamid.SZ.${++seq}`, status: 'accepted', timestamp: '1' } }))
  gateway = createGateway(loadConfig({ SENDZEN_API_BASE: mock.base, NUMBER_MAP: JSON.stringify({ [PNID]: { from: '+15555550100' } }), SENDZEN_TIMEOUT_MS: '500' }), { log: () => {} })
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r))
  vi.resetModules()
  vi.stubEnv('WHATSAPP_API_BASE_URL', `http://127.0.0.1:${gateway.address().port}/v21.0`)
  api = await import('./meta-api')
}, 60_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await closeIt(gateway)
  await closeIt(mock.server)
})

beforeEach(() => { mock.calls.length = 0; seq = 0; next = null })

const common = { phoneNumberId: PNID, accessToken: KEY, to: TO }

describe('MAQUETTE — meta-api.ts → Z′ gateway → mock SendZen: exact request received', () => {
  it('sendTextMessage', async () => {
    const r = await api.sendTextMessage({ ...common, text: 'Bonjour 👋 — accents éàç' })
    expect(r.messageId).toBe('wamid.SZ.1')
    expect(mock.calls).toEqual([{ method: 'POST', url: '/v1/messages', auth: `Bearer ${KEY}`, body: { from: '+15555550100', to: TO, type: 'text', text: { body: 'Bonjour 👋 — accents éàç' } } }])
  })

  it('sendInteractiveButtons (3 buttons, header, footer, reply context)', async () => {
    const r = await api.sendInteractiveButtons({
      ...common, bodyText: 'Vous êtes ?', headerText: 'TranZit', footerText: 'STOP pour se désinscrire', contextMessageId: 'wamid.IN.1',
      buttons: [{ id: 'tz_driver', title: 'Chauffeur' }, { id: 'tz_carrier', title: 'Transporteur' }, { id: 'tz_other', title: 'Autre' }],
    })
    expect(r.messageId).toBe('wamid.SZ.1')
    expect(mock.calls[0].auth).toBe(`Bearer ${KEY}`)
    expect(mock.calls[0].body).toEqual({
      from: '+15555550100', to: TO, type: 'interactive', context: { message_id: 'wamid.IN.1' },
      interactive: {
        type: 'button', header: { type: 'text', text: 'TranZit' }, body: { text: 'Vous êtes ?' }, footer: { text: 'STOP pour se désinscrire' },
        action: { buttons: [
          { type: 'reply', reply: { id: 'tz_driver', title: 'Chauffeur' } },
          { type: 'reply', reply: { id: 'tz_carrier', title: 'Transporteur' } },
          { type: 'reply', reply: { id: 'tz_other', title: 'Autre' } },
        ] },
      },
    })
  })

  it('sendInteractiveList (10 rows over 2 sections, descriptions)', async () => {
    const rows = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, title: `Ville ${p}${i}`, ...(i === 0 ? { description: 'Première' } : {}) }))
    const sections = [{ title: 'Nord', rows: rows('n', 4) }, { title: 'Sud', rows: rows('s', 6) }]
    const r = await api.sendInteractiveList({ ...common, bodyText: 'Votre ville ?', buttonLabel: 'Choisir', sections })
    expect(r.messageId).toBe('wamid.SZ.1')
    expect(mock.calls[0].body).toEqual({
      from: '+15555550100', to: TO, type: 'interactive',
      interactive: { type: 'list', body: { text: 'Votre ville ?' }, action: { button: 'Choisir', sections } },
    })
  })

  it('limits are enforced by waCRM BEFORE the network: 4 buttons / 11 rows / 21-char title never reach the gateway', async () => {
    await expect(api.sendInteractiveButtons({ ...common, bodyText: 'x', buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}` })) })).rejects.toThrow()
    await expect(api.sendInteractiveButtons({ ...common, bodyText: 'x', buttons: [{ id: 'a', title: 'x'.repeat(21) }] })).rejects.toThrow()
    await expect(api.sendInteractiveList({ ...common, bodyText: 'x', buttonLabel: 'Choisir', sections: [{ rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `R${i}` })) }] })).rejects.toThrow()
    expect(mock.calls).toHaveLength(0)
  })

  it('a SendZen error surfaces in waCRM as a thrown error carrying SendZen\'s message (never a fake success)', async () => {
    next = () => ({ status: 400, json: { error: { code: 'INVALID_RECIPIENT', message: 'Recipient is not a valid WhatsApp user', details: 'ci-dummy' } } })
    await expect(api.sendTextMessage({ ...common, text: 'x' })).rejects.toThrow(/Recipient is not a valid WhatsApp user/)
    expect(mock.calls).toHaveLength(1)
  })

  it('an unknown phone_number_id is refused by the gateway (404) and SendZen is not called', async () => {
    await expect(api.sendTextMessage({ ...common, phoneNumberId: '999999999999999', text: 'x' })).rejects.toThrow(/Unknown phone number id/)
    expect(mock.calls).toHaveLength(0)
  })

  it('a SendZen timeout surfaces in waCRM as a thrown 504 error (never a fake success)', async () => {
    next = () => ({ hang: true })
    await expect(api.sendTextMessage({ ...common, text: 'x' })).rejects.toMatchObject({ httpStatus: 504, message: 'SendZen did not answer in time' })
  })

  it('unsupported types and sub-types surface as 501 errors and SendZen is not called', async () => {
    await expect(api.sendTemplateMessage({ ...common, templateName: 'ci_dummy', language: 'fr' })).rejects.toMatchObject({ httpStatus: 501, type: 'GatewayNotImplemented' })
    await expect(api.sendReactionMessage({ ...common, targetMessageId: 'wamid.X', emoji: '👍' })).rejects.toMatchObject({ httpStatus: 501 })
    expect(mock.calls).toHaveLength(0)
  })
})
