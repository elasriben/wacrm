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
 *   - https only (plain http is accepted for loopback hosts, for tests, and
 *     for the internal hosts listed in `WHATSAPP_API_ALLOWED_HTTP_HOSTS`);
 *   - no embedded credentials, query string or fragment;
 *   - trailing slashes are removed.
 * An invalid value throws at startup rather than silently falling back to
 * Meta, which would send tokens somewhere the operator did not intend.
 */
export const DEFAULT_GRAPH_API_BASE = 'https://graph.facebook.com/v21.0'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * `WHATSAPP_API_ALLOWED_HTTP_HOSTS` — comma-separated host names (no scheme,
 * port, path or wildcard) that may be reached over plain http, e.g. a gateway
 * on a private Docker network (`sendzen-gateway`). Matching is exact and
 * case-insensitive: `sendzen-gateway` does not allow `sendzen-gateway.evil.example`.
 * Unset or blank keeps the https-only behaviour.
 */
export function parseAllowedHttpHosts(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function resolveGraphApiBase(
  raw: string | undefined = process.env.WHATSAPP_API_BASE_URL,
  allowedHttpHosts: string | undefined = process.env.WHATSAPP_API_ALLOWED_HTTP_HOSTS,
): string {
  const value = raw?.trim()
  if (!value) return DEFAULT_GRAPH_API_BASE

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('WHATSAPP_API_BASE_URL is not a valid URL')
  }
  const httpAllowed = LOOPBACK_HOSTS.has(url.hostname) || parseAllowedHttpHosts(allowedHttpHosts).has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && httpAllowed)) {
    throw new Error(
      'WHATSAPP_API_BASE_URL must use https (http is only allowed for localhost and WHATSAPP_API_ALLOWED_HTTP_HOSTS)',
    )
  }
  if (url.username || url.password) {
    throw new Error('WHATSAPP_API_BASE_URL must not contain credentials')
  }
  if (url.search || url.hash) {
    throw new Error('WHATSAPP_API_BASE_URL must not contain a query string or fragment')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
