import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// meta-api.ts resolves its base at module load, so each case re-imports it
// with the environment it needs.
async function loadMetaApi(base?: string) {
  vi.resetModules()
  if (base === undefined) vi.stubEnv('WHATSAPP_API_BASE_URL', '')
  else vi.stubEnv('WHATSAPP_API_BASE_URL', base)
  return import('./meta-api')
}

function mockFetchOk(json: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('meta-api honours WHATSAPP_API_BASE_URL', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('sends to Meta Graph v21.0 by default (behaviour unchanged)', async () => {
    const { sendTextMessage } = await loadMetaApi()
    const fetchMock = mockFetchOk({ messages: [{ id: 'wamid.1' }] })
    const r = await sendTextMessage({ phoneNumberId: '111', accessToken: 'tok', to: '212600000001', text: 'hi' })
    expect(r.messageId).toBe('wamid.1')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v21.0/111/messages')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('sends text, buttons and list to the configured gateway, keeping the Meta body and path shape', async () => {
    const { sendTextMessage, sendInteractiveButtons, sendInteractiveList } = await loadMetaApi('http://127.0.0.1:9999/v21.0/')
    const fetchMock = mockFetchOk({ messages: [{ id: 'wamid.gw' }] })

    await sendTextMessage({ phoneNumberId: '111', accessToken: 'tok', to: '212600000001', text: 'hi' })
    await sendInteractiveButtons({
      phoneNumberId: '111', accessToken: 'tok', to: '212600000001', bodyText: 'Choisissez',
      buttons: [{ id: 'a', title: 'Oui' }, { id: 'b', title: 'Non' }],
    })
    await sendInteractiveList({
      phoneNumberId: '111', accessToken: 'tok', to: '212600000001', bodyText: 'Choisissez', buttonLabel: 'Voir',
      sections: [{ title: 'Types', rows: [{ id: 'r1', title: 'Chauffeur' }, { id: 'r2', title: 'Transporteur' }] }],
    })

    const urls = fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(urls).toEqual([
      'http://127.0.0.1:9999/v21.0/111/messages',
      'http://127.0.0.1:9999/v21.0/111/messages',
      'http://127.0.0.1:9999/v21.0/111/messages',
    ])
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String(((c as unknown as [string, RequestInit])[1]).body)))
    expect(bodies[0]).toMatchObject({ messaging_product: 'whatsapp', type: 'text' })
    expect(bodies[1]).toMatchObject({ type: 'interactive', interactive: { type: 'button' } })
    expect(bodies[2]).toMatchObject({ type: 'interactive', interactive: { type: 'list' } })
  })

  it('routes the media and phone lookups through the gateway too', async () => {
    const { getMediaUrl, verifyPhoneNumber } = await loadMetaApi('https://wa-gw.internal.example/v21.0')
    const fetchMock = mockFetchOk({ id: 'm1', url: 'https://wa-gw.internal.example/media/m1', mime_type: 'image/jpeg', display_phone_number: '+212', verified_name: 'x' })
    await getMediaUrl({ mediaId: 'm1', accessToken: 'tok' })
    await verifyPhoneNumber({ phoneNumberId: '111', accessToken: 'tok' })
    const urls = fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(urls[0]).toBe('https://wa-gw.internal.example/v21.0/m1')
    expect(urls[1]).toMatch(/^https:\/\/wa-gw\.internal\.example\/v21\.0\/111\?fields=/)
  })

  it('fails loudly at load time on an invalid override instead of falling back to Meta', async () => {
    await expect(loadMetaApi('http://gateway.example/v21.0')).rejects.toThrow(/https/)
  })
})
