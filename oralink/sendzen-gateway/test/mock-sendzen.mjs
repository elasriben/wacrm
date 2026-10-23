// MOCK — NOT SendZen. A stand-in built ONLY from the request/response shapes found in SendZen's public
// documentation (POST /v1/messages {from,to,type,...} -> 202 {message_id,status,to,timestamp}; errors
// {error:{code,message,details}} + X-Request-ID). It proves the gateway's translation logic; it proves
// nothing about how the real SendZen behaves. Real behaviour is established by ../sendzen-test-kit.
import http from 'node:http'

export function startMockSendzen(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    const call = { method: req.method, url: req.url, auth: req.headers.authorization, body }
    calls.push(call)
    const r = handler ? await handler(call) : { status: 202, json: { message_id: 'wamid.MOCK1', status: 'accepted', to: body?.to, timestamp: '1' } }
    if (r.hang) return // never answers (timeout test)
    res.writeHead(r.status, { 'content-type': r.raw ? 'text/plain' : 'application/json', 'x-request-id': 'req-mock-1' })
    res.end(r.raw ?? JSON.stringify(r.json))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) })))
}
