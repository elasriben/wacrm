// MOCK — NOT SendZen. A stand-in built ONLY from the request/response shapes found in SendZen's public
// documentation (POST /v1/messages {from,to,type,...} -> 202 {message_id,status,to,timestamp}; errors
// {error:{code,message,details}} + X-Request-ID). It proves the gateway's translation logic; it proves
// nothing about how the real SendZen behaves. Real behaviour is established by ../sendzen-test-kit.
import http from 'node:http'
import crypto from 'node:crypto'

export function startMockSendzen(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    let body = null; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null } catch { body = { __invalidJson: true } }
    const call = { method: req.method, url: req.url, auth: req.headers.authorization, body }
    calls.push(call)
    const r = handler ? await handler(call) : { status: 202, json: { message_id: 'wamid.MOCK1', status: 'accepted', to: body?.to, timestamp: '1' } }
    if (r.hang) return // never answers (timeout test)
    res.writeHead(r.status, { 'content-type': r.raw ? 'text/plain' : 'application/json', 'x-request-id': 'req-mock-1', ...(r.headers ?? {}) })
    res.end(r.raw ?? JSON.stringify(r.json))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) })))
}

// ---- Inbound side of the mock: webhooks "SendZen" would POST to waCRM -------------------------------
// Shapes follow the Meta Cloud API webhook format, which SendZen announces it forwards unchanged
// (TEST-PLAN D1/T-S2). NOT verified against the real SendZen: these builders only let the local tests
// exercise waCRM's real webhook handler with the payloads we EXPECT to receive.

/** `X-Hub-Signature-256` value for a raw body, as Meta (and, per its docs, SendZen) computes it. */
export function signWebhook(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** Wrap one inbound message in a Meta-format webhook envelope. */
export function inboundEnvelope({ phoneNumberId, displayPhone = '15555550150', wabaId = 'WABA-TEST', waId, name = 'Test Contact', message }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: displayPhone, phone_number_id: phoneNumberId },
      contacts: [{ profile: { name }, wa_id: waId }],
      messages: [{ from: waId, ...message }],
    } }] }],
  }
}

export const inboundText = ({ id, text, timestamp = '1760000000' }) => ({ id, timestamp, type: 'text', text: { body: text } })

/** A customer tapping reply button `index` of an outbound interactive message the mock received. */
export function tapButton(outboundCall, sentMessageId, index, { id, timestamp = '1760000060' }) {
  const b = outboundCall.body?.interactive?.action?.buttons?.[index]?.reply
  if (!b) throw new Error(`outbound call has no button #${index}`)
  return { id, timestamp, type: 'interactive', context: { from: outboundCall.body.from, id: sentMessageId }, interactive: { type: 'button_reply', button_reply: { id: b.id, title: b.title } } }
}

/** A customer choosing row (section, row) of an outbound list message the mock received. */
export function chooseRow(outboundCall, sentMessageId, sectionIndex, rowIndex, { id, timestamp = '1760000060' }) {
  const r = outboundCall.body?.interactive?.action?.sections?.[sectionIndex]?.rows?.[rowIndex]
  if (!r) throw new Error(`outbound call has no row #${sectionIndex}/${rowIndex}`)
  return { id, timestamp, type: 'interactive', context: { from: outboundCall.body.from, id: sentMessageId }, interactive: { type: 'list_reply', list_reply: { id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) } } }
}
