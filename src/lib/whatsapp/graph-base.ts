/**
 * Base URL of the WhatsApp Graph API.
 *
 * Default: Meta's Graph API (unchanged behaviour). Operators who route
 * WhatsApp through a compatible gateway (for example a BSP adapter) can set
 * `WHATSAPP_API_BASE_URL` — SERVER-SIDE ONLY, never a NEXT_PUBLIC_ variable —
 * to the full base including the version segment, e.g.
 * `https://wa-gateway.internal.example/v21.0`.
 *
 * The value is operator-controlled (an environment variable), never user
 * input, so it is not subject to the SSRF guard — but it is validated here
 * because the access token is sent to it as a Bearer credential:
 *   - https only (plain http is accepted for loopback hosts, for tests);
 *   - no embedded credentials, query string or fragment;
 *   - trailing slashes are removed.
 * An invalid value throws at startup rather than silently falling back to
 * Meta, which would send tokens somewhere the operator did not intend.
 */
export const DEFAULT_GRAPH_API_BASE = 'https://graph.facebook.com/v21.0'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function resolveGraphApiBase(raw: string | undefined = process.env.WHATSAPP_API_BASE_URL): string {
  const value = raw?.trim()
  if (!value) return DEFAULT_GRAPH_API_BASE

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('WHATSAPP_API_BASE_URL is not a valid URL')
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('WHATSAPP_API_BASE_URL must use https (http is only allowed for localhost)')
  }
  if (url.username || url.password) {
    throw new Error('WHATSAPP_API_BASE_URL must not contain credentials')
  }
  if (url.search || url.hash) {
    throw new Error('WHATSAPP_API_BASE_URL must not contain a query string or fragment')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
