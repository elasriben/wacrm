// MAQUETTE (MOCK) — tests de contrat waCRM (format Graph) -> passerelle -> SendZen SIMULÉ.
//
// Le "SendZen" de ces tests est ./mock-sendzen.mjs : une maquette locale (127.0.0.1, port 0) construite
// à partir des formes de requête/réponse de la documentation publique. Ces tests prouvent la TRADUCTION
// faite par la passerelle et ses refus ; ils ne prouvent RIEN du comportement réel de SendZen (codes
// d'erreur, schéma de liste, champ `from`…), qui reste ❓ jusqu'aux tests réels T-S1…T-S10
// (oralink/sendzen-test-kit/TEST-PLAN.md, accord humain requis).
// Les identifiants C-xx renvoient à docs/oralink/sendzen/contract.md. Aucun réseau sortant, aucune clé
// réelle, numéros de la plage fictive nord-américaine 555-01xx uniquement.
import { describe, test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createGateway, loadConfig, TEXT_BODY_MAX } from '../server.mjs'
import { startMockSendzen } from './mock-sendzen.mjs'

const closeServer = (s) => new Promise((resolve) => { const t = setTimeout(resolve, 1000); t.unref(); s.close(() => resolve()); s.closeAllConnections?.() })

const TOKEN = 'ci-dummy-sendzen-key-contract'
const PNID = '111111111111111'
const FROM = '+15555550100'
const TO = '15555550199'
let mock, other, gw, base, logs, handler

const startGateway = async (env = {}, deps = {}) => {
  if (gw) await closeServer(gw)
  gw = createGateway(loadConfig({ SENDZEN_API_BASE: mock.base, NUMBER_MAP: JSON.stringify({ [PNID]: { from: FROM } }), SENDZEN_TIMEOUT_MS: '300', MAX_BODY_BYTES: '32768', ...env }), { log: (l) => logs.push(l), ...deps })
  await new Promise((r) => gw.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${gw.address().port}`
}

before(async () => {
  mock = await startMockSendzen((c) => handler(c))
  other = await startMockSendzen(() => ({ status: 202, json: { message_id: 'wamid.OTHER' } }))
})
after(async () => { if (gw) await closeServer(gw); await closeServer(mock.server); await closeServer(other.server) })
beforeEach(async () => {
  mock.calls.length = 0; other.calls.length = 0; logs = []
  handler = () => ({ status: 202, json: { message_id: 'wamid.MOCK.1', status: 'accepted', to: TO, timestamp: '1' } })
  await startGateway()
})

const send = (body, { path = `/v21.0/${PNID}/messages`, auth = `Bearer ${TOKEN}` } = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const graph = (type, payload, extra = {}) => ({ messaging_product: 'whatsapp', recipient_type: 'individual', to: TO, type, [type]: payload, ...extra })
const BUTTONS = { type: 'button', body: { text: 'Vous êtes ?' }, footer: { text: 'STOP pour arrêter' }, action: { buttons: [{ type: 'reply', reply: { id: 'b1', title: 'Chauffeur' } }, { type: 'reply', reply: { id: 'b2', title: 'Transporteur' } }, { type: 'reply', reply: { id: 'b3', title: 'Autre' } }] } }
const LIST = (n = 10) => ({ type: 'list', body: { text: 'Votre ville ?' }, action: { button: 'Choisir', sections: [{ title: 'Villes', rows: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `Ville ${i}` })) }] } })

async function refused(res, status, { type, code } = {}) {
  assert.equal(res.status, status)
  const j = await res.json()
  assert.ok(j.error && typeof j.error.message === 'string', 'Meta-shaped error body')
  if (type) assert.equal(j.error.type, type)
  if (code !== undefined) assert.equal(j.error.code, code)
  assert.equal(j.messages, undefined, 'never a success body')
  return j.error
}

describe('MAQUETTE — envoi : traduction Graph -> SendZen (C-01 à C-04)', () => {
  test('C-01 texte : POST /v1/messages, Bearer transmis tel quel, from depuis NUMBER_MAP, champs Meta retirés', async () => {
    const r = await send(graph('text', { body: 'Bonjour 👋 éàç' }, { context: { message_id: 'wamid.IN.1' } }))
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { messaging_product: 'whatsapp', contacts: [{ input: TO }], messages: [{ id: 'wamid.MOCK.1' }] })
    assert.equal(mock.calls.length, 1)
    assert.deepEqual(mock.calls[0], { method: 'POST', url: '/v1/messages', auth: `Bearer ${TOKEN}`, body: { from: FROM, to: TO, type: 'text', text: { body: 'Bonjour 👋 éàç' }, context: { message_id: 'wamid.IN.1' } } })
  })

  test('C-01 la réponse 200 ne contient que ce que SendZen a renvoyé (id) : pas de wa_id fabriqué', async () => {
    const j = await (await send(graph('text', { body: 'x' }))).json()
    assert.equal(j.contacts[0].wa_id, undefined)
  })

  test('C-02 boutons (3) : objet interactive transmis à l’identique', async () => {
    const r = await send(graph('interactive', BUTTONS))
    assert.equal(r.status, 200)
    assert.deepEqual(mock.calls[0].body, { from: FROM, to: TO, type: 'interactive', interactive: BUTTONS })
  })

  test('C-03 liste (10 lignes) : objet interactive transmis à l’identique', async () => {
    const r = await send(graph('interactive', LIST(10)))
    assert.equal(r.status, 200)
    assert.deepEqual(mock.calls[0].body, { from: FROM, to: TO, type: 'interactive', interactive: LIST(10) })
  })

  test('C-04 liste blanche de champs : `from` du corps ignoré, champs inconnus retirés, context réduit à message_id', async () => {
    const r = await send({ ...graph('text', { body: 'x' }), from: '+15555550150', extra: { a: 1 }, template: { name: 't' }, context: { message_id: 'wamid.X', from: 'y' } })
    assert.equal(r.status, 200)
    assert.deepEqual(mock.calls[0].body, { from: FROM, to: TO, type: 'text', text: { body: 'x' }, context: { message_id: 'wamid.X' } })
  })
})

describe('MAQUETTE — limites et validation, SendZen jamais appelé (C-05 à C-07)', () => {
  test('C-05 4 boutons, 11 lignes, titre de 21 caractères -> 400 (#131009)', async () => {
    const four = structuredClone(BUTTONS); four.action.buttons.push({ type: 'reply', reply: { id: 'b4', title: 'B4' } })
    await refused(await send(graph('interactive', four)), 400, { type: 'GatewayValidationError', code: 131009 })
    await refused(await send(graph('interactive', LIST(11))), 400, { code: 131009 })
    const long = structuredClone(BUTTONS); long.action.buttons[0].reply.title = 'x'.repeat(21)
    await refused(await send(graph('interactive', long)), 400, { code: 131009 })
    assert.equal(mock.calls.length, 0)
  })

  test(`C-06 texte : vide ou > ${TEXT_BODY_MAX} caractères -> 400 ; exactement ${TEXT_BODY_MAX} -> transmis`, async () => {
    await refused(await send(graph('text', { body: '  ' })), 400, { code: 131009 })
    await refused(await send(graph('text', {})), 400, { code: 131009 })
    await refused(await send(graph('text', { body: 'é'.repeat(TEXT_BODY_MAX + 1) })), 400, { code: 131009 })
    assert.equal(mock.calls.length, 0)
    assert.equal((await send(graph('text', { body: 'é'.repeat(TEXT_BODY_MAX) }))).status, 200)
  })

  test('C-07 destinataire : BSUID / username refusé (400), `to` non numérique refusé (400)', async () => {
    await refused(await send({ messaging_product: 'whatsapp', recipient: 'US.ci-dummy-bsuid', type: 'text', text: { body: 'x' } }), 400)
    await refused(await send(graph('text', { body: 'x' }, { to: 'abc' })), 400, { code: 131009 })
    await refused(await send(graph('text', { body: 'x' }, { context: { message_id: 42 } })), 400, { code: 131009 })
    assert.equal(mock.calls.length, 0)
  })
})

describe('MAQUETTE — types et opérations non supportés : 501 explicite (C-08, C-09)', () => {
  test('C-08 template, médias, réaction, localisation, contacts, sticker, accusé de lecture -> 501, SendZen jamais appelé', async () => {
    const bodies = [
      graph('template', { name: 'x', language: { code: 'fr' } }),
      ...['image', 'video', 'audio', 'document', 'sticker'].map((t) => graph(t, { link: 'https://example.invalid/f' })),
      graph('reaction', { message_id: 'wamid.X', emoji: '👍' }),
      graph('location', { latitude: 0, longitude: 0 }),
      graph('contacts', []),
      { messaging_product: 'whatsapp', to: TO },
      { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.X' },
    ]
    for (const b of bodies) await refused(await send(b), 501, { type: 'GatewayNotImplemented', code: 501 })
    for (const sub of [{ type: 'cta_url', body: { text: 'x' }, action: {} }, { ...BUTTONS, header: { type: 'image', image: { link: 'https://example.invalid/x.png' } } }]) {
      await refused(await send(graph('interactive', sub)), 501, { type: 'GatewayNotImplemented' })
    }
    assert.equal(mock.calls.length, 0)
  })

  test('C-09 configuration, modèles, médias entrants, chemins inconnus -> 501 (aucune simulation)', async () => {
    for (const [method, path] of [
      ['GET', `/v21.0/${PNID}?fields=id,display_phone_number`], ['POST', `/v21.0/${PNID}/register`], ['POST', '/v21.0/1234567/subscribed_apps'],
      ['GET', '/v21.0/1234567/phone_numbers'], ['GET', '/v21.0/1234567/message_templates'], ['DELETE', '/v21.0/1234567/message_templates?name=x'],
      ['GET', '/v21.0/987654321'], ['POST', '/v21.0/1234567/uploads'], ['PUT', `/v21.0/${PNID}/messages`],
    ]) {
      const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}` }, body: ['POST', 'PUT'].includes(method) ? '{}' : undefined })
      await refused(r, 501, { type: 'GatewayNotImplemented' })
    }
    assert.equal(mock.calls.length, 0)
  })
})

describe('MAQUETTE — routage et authentification (C-10, C-11)', () => {
  test('C-10 phone_number_id inconnu -> 404 ; noms de propriétés héritées refusés aussi ; SendZen jamais appelé', async () => {
    for (const id of ['999999999999999', '__proto__', 'constructor', 'toString']) {
      await refused(await send(graph('text', { body: 'x' }), { path: `/v21.0/${id}/messages` }), 404, { code: 100 })
    }
    assert.equal(mock.calls.length, 0)
  })

  test('C-11 en-tête Authorization absent ou mal formé -> 401 (code 190), SendZen jamais appelé', async () => {
    for (const auth of [null, 'Basic abc', 'Bearer', 'Bearer a b', `Bearer ${'x'.repeat(5000)}`]) {
      await refused(await send(graph('text', { body: 'x' }), { auth }), 401, { code: 190 })
    }
    assert.equal(mock.calls.length, 0)
  })
})

describe('MAQUETTE — erreurs amont : jamais de faux succès (C-12 à C-14)', () => {
  test('C-12 erreur SendZen 4xx/5xx : statut, message et X-Request-ID remontés ; details non-texte ignorés', async () => {
    handler = () => ({ status: 429, json: { error: { code: 'RATE_LIMIT', message: 'Too many requests', details: { nested: true } } } })
    const e = await refused(await send(graph('text', { body: 'x' })), 429, { type: 'SendZenError', code: 1 })
    assert.equal(e.message, 'Too many requests'); assert.equal(e.fbtrace_id, 'req-mock-1'); assert.equal(e.error_data, undefined)
    handler = () => ({ status: 500, raw: 'boom' })
    assert.equal((await refused(await send(graph('text', { body: 'x' })), 500)).message, 'SendZen error 500')
  })

  test('C-13 réponse 2xx sans id, non-JSON ou trop volumineuse -> 502', async () => {
    for (const h of [() => ({ status: 202, json: { status: 'accepted' } }), () => ({ status: 200, raw: '<html>' }), () => ({ status: 202, raw: 'x'.repeat(70000) })]) {
      handler = h
      await refused(await send(graph('text', { body: 'x' })), 502, { code: 2 })
    }
  })

  test('C-13 redirection amont : jamais suivie (le jeton ne part pas ailleurs) -> 502', async () => {
    handler = () => ({ status: 307, headers: { location: `${other.base}/v1/messages` }, json: {} })
    await refused(await send(graph('text', { body: 'x' })), 502)
    assert.equal(other.calls.length, 0)
  })

  test('C-14 délai dépassé -> 504 ; SendZen injoignable -> 502', async () => {
    handler = () => ({ hang: true })
    await refused(await send(graph('text', { body: 'x' })), 504, { code: 2 })
    const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r)); const port = dead.address().port; await closeServer(dead)
    await startGateway({ SENDZEN_API_BASE: `http://127.0.0.1:${port}` })
    await refused(await send(graph('text', { body: 'x' })), 502, { code: 2 })
  })

  test('C-14 exception interne inattendue -> 500 sans détail, et la passerelle continue de servir', async () => {
    await startGateway({}, { fetch: async () => ({ ok: true, status: 200, body: null, headers: { get: () => { throw new Error('ci-dummy secret detail') } } }) })
    const e = await refused(await send(graph('text', { body: 'x' })), 500)
    assert.equal(e.message, 'Internal gateway error')
    assert.equal((await fetch(base + '/healthz')).status, 200)
  })
})

describe('MAQUETTE — corps bornés et journaux (C-15, C-16)', () => {
  test('C-15 corps trop gros : Content-Length annoncé ou flux chunked -> 413, SendZen jamais appelé', async () => {
    await refused(await send(graph('text', { body: 'x'.repeat(40000) })), 413)
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/v21.0/${PNID}/messages`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      for (let i = 0; i < 40; i++) req.write('x'.repeat(1024))
      req.end()
    })
    assert.equal(status, 413)
    assert.equal(mock.calls.length, 0)
  })

  test('C-16 journaux : ni jeton, ni texte, ni numéro, ni identifiant de chemin, quel que soit le scénario', async () => {
    const secretText = 'ci-dummy texte confidentiel'
    await send(graph('text', { body: secretText }))
    await send(graph('text', { body: secretText }), { path: '/v21.0/15555550177/messages' })
    await fetch(`${base}/v21.0/15555550166/message_templates`)
    handler = () => ({ status: 400, json: { error: { message: `bad ${TO}` } } })
    await send(graph('text', { body: secretText }))
    await send('{not json')
    assert.ok(logs.length >= 5)
    const all = logs.join('\n')
    for (const leak of [TOKEN, secretText, TO, FROM, PNID, '15555550177', '15555550166']) assert.ok(!all.includes(leak), `journal contient ${leak}`)
    for (const l of logs) assert.deepEqual(Object.keys(JSON.parse(l)).sort(), ['m', 'ms', 'note', 'route', 'status'])
  })
})

describe('MAQUETTE — configuration au démarrage (C-17)', () => {
  test('C-17 ALLOW_TYPES ne peut pas élargir le contrat ; nombres et URL validés', () => {
    assert.throws(() => loadConfig({ ALLOW_TYPES: 'text,template' }), /ALLOW_TYPES may only contain/)
    assert.deepEqual([...loadConfig({ ALLOW_TYPES: 'text' }).allowTypes], ['text'])
    assert.throws(() => loadConfig({ MAX_BODY_BYTES: 'abc' }), /MAX_BODY_BYTES/)
    assert.throws(() => loadConfig({ SENDZEN_TIMEOUT_MS: '0' }), /SENDZEN_TIMEOUT_MS/)
    assert.throws(() => loadConfig({ SENDZEN_API_BASE: 'https://user:pw@api.example.invalid' }), /credentials/)
    assert.throws(() => loadConfig({ SENDZEN_API_BASE: 'http://sendzen.example.invalid' }), /https/)
    assert.throws(() => loadConfig({ NUMBER_MAP: '[]' }), /JSON object/)
  })

  test('C-17 ALLOW_TYPES=text : interactive répond 501', async () => {
    await startGateway({ ALLOW_TYPES: 'text' })
    await refused(await send(graph('interactive', BUTTONS)), 501, { type: 'GatewayNotImplemented' })
    assert.equal(mock.calls.length, 0)
  })
})
