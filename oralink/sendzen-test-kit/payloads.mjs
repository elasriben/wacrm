// Test message payloads (Meta/SendZen "session" shapes) + safety guards for send-test.mjs.
export const LIMITS = { buttonTitle: 20, rowTitle: 24, maxButtons: 3, maxRows: 10 }

export function textMessage({ from, to }) { return { from, to, type: 'text', text: { body: 'Test OraLink : répondez par un mot.' } } }

export function buttons3({ from, to }) {
  return { from, to, type: 'interactive', interactive: { type: 'button', body: { text: 'Test OraLink : vous êtes ?' }, action: { buttons: [
    { type: 'reply', reply: { id: 'test_driver', title: 'Chauffeur' } },
    { type: 'reply', reply: { id: 'test_carrier', title: 'Transporteur' } },
    { type: 'reply', reply: { id: 'test_other', title: 'Autre' } } ] } } }
}

export function list(n, { from, to }) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `test_row_${i + 1}`, title: `Option ${i + 1}`, description: i === 0 ? 'Première ligne' : undefined }))
  return { from, to, type: 'interactive', interactive: { type: 'list', body: { text: 'Test OraLink : choisissez' }, action: { button: 'Choisir', sections: [{ title: 'Options', rows }] } } }
}

export const CASES = {
  text: (c) => textMessage(c),
  buttons3: (c) => buttons3(c),
  list3: (c) => list(3, c),
  list10: (c) => list(10, c),
  list11: (c) => list(11, c), // NEGATIVE test: must be rejected by WhatsApp/SendZen (limit is 10 rows)
}

/** Refuses anything that could touch a production number or an unlisted recipient. */
export function assertSafeToSend(env) {
  const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean)
  const { FROM, TO } = env
  const testFrom = csv(env.TEST_FROM), allowedTo = csv(env.ALLOWED_TEST_RECIPIENTS), protectedFrom = csv(env.PROTECTED_FROM)
  if (!FROM || !TO) throw new Error('FROM and TO are required')
  if (!testFrom.length || !allowedTo.length) throw new Error('TEST_FROM and ALLOWED_TEST_RECIPIENTS must be set explicitly')
  if (protectedFrom.includes(FROM)) throw new Error(`FROM ${FROM} is listed in PROTECTED_FROM (production number) — refusing`)
  if (!testFrom.includes(FROM)) throw new Error('FROM is not in TEST_FROM — refusing')
  if (!allowedTo.includes(TO)) throw new Error('TO is not in ALLOWED_TEST_RECIPIENTS — refusing')
  if (!env.SENDZEN_API_KEY) throw new Error('SENDZEN_API_KEY is required for --send')
}
