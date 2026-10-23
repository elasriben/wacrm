import { describe, expect, it } from 'vitest'
import { DEFAULT_GRAPH_API_BASE, parseAllowedHttpHosts, resolveGraphApiBase } from './graph-base'

describe('resolveGraphApiBase', () => {
  it('defaults to Meta Graph v21.0 when unset or blank', () => {
    expect(resolveGraphApiBase(undefined)).toBe('https://graph.facebook.com/v21.0')
    expect(resolveGraphApiBase('')).toBe(DEFAULT_GRAPH_API_BASE)
    expect(resolveGraphApiBase('   ')).toBe(DEFAULT_GRAPH_API_BASE)
  })

  it('accepts an https base and keeps its path, trimming trailing slashes', () => {
    expect(resolveGraphApiBase('https://wa-gw.internal.example/v21.0')).toBe('https://wa-gw.internal.example/v21.0')
    expect(resolveGraphApiBase('https://wa-gw.internal.example/v21.0///')).toBe('https://wa-gw.internal.example/v21.0')
    expect(resolveGraphApiBase('https://wa-gw.internal.example/')).toBe('https://wa-gw.internal.example')
    expect(resolveGraphApiBase('  https://wa-gw.internal.example:8443/wa/v21.0/ ')).toBe('https://wa-gw.internal.example:8443/wa/v21.0')
  })

  it('accepts plain http only for loopback hosts', () => {
    expect(resolveGraphApiBase('http://127.0.0.1:8080/v21.0')).toBe('http://127.0.0.1:8080/v21.0')
    expect(resolveGraphApiBase('http://localhost:8080')).toBe('http://localhost:8080')
    expect(resolveGraphApiBase('http://[::1]:8080/v21.0')).toBe('http://[::1]:8080/v21.0')
    expect(() => resolveGraphApiBase('http://gateway.example/v21.0')).toThrow(/https/)
    expect(() => resolveGraphApiBase('http://127.0.0.1.evil.example/v21.0')).toThrow(/https/)
  })

  it('accepts plain http for hosts listed in WHATSAPP_API_ALLOWED_HTTP_HOSTS', () => {
    expect(resolveGraphApiBase('http://sendzen-gateway:8080', 'sendzen-gateway')).toBe('http://sendzen-gateway:8080')
    expect(resolveGraphApiBase('http://sendzen-gateway:8080/v21.0/', 'other, sendzen-gateway')).toBe(
      'http://sendzen-gateway:8080/v21.0',
    )
  })

  it('normalises the allow-list (spaces, case, empty entries)', () => {
    expect([...parseAllowedHttpHosts(' Sendzen-Gateway , ,wa-gw ')]).toEqual(['sendzen-gateway', 'wa-gw'])
    expect(resolveGraphApiBase('http://SENDZEN-GATEWAY:8080', '  Sendzen-Gateway  ')).toBe('http://sendzen-gateway:8080')
  })

  it('keeps https-only behaviour when the allow-list is unset or blank', () => {
    expect(() => resolveGraphApiBase('http://sendzen-gateway:8080', undefined)).toThrow(/https/)
    expect(() => resolveGraphApiBase('http://sendzen-gateway:8080', '')).toThrow(/https/)
    expect(() => resolveGraphApiBase('http://sendzen-gateway:8080', ' , ')).toThrow(/https/)
  })

  it('rejects hosts that are not listed exactly', () => {
    expect(() => resolveGraphApiBase('http://gateway.example/v21.0', 'sendzen-gateway')).toThrow(/https/)
    expect(() => resolveGraphApiBase('http://sendzen-gateway.evil.example/v21.0', 'sendzen-gateway')).toThrow(/https/)
    expect(() => resolveGraphApiBase('http://api.sendzen-gateway/v21.0', 'sendzen-gateway')).toThrow(/https/)
    expect(() => resolveGraphApiBase('http://sendzen-gateway:8080', '*')).toThrow(/https/)
    expect(() => resolveGraphApiBase('http://sendzen-gateway:8080', 'sendzen-gateway:8080')).toThrow(/https/)
  })

  it('still rejects credentials, query strings and fragments on an allowed http host', () => {
    expect(() => resolveGraphApiBase('http://u:p@sendzen-gateway:8080', 'sendzen-gateway')).toThrow(/credentials/)
    expect(() => resolveGraphApiBase('http://sendzen-gateway:8080/?x=1', 'sendzen-gateway')).toThrow(/query/)
  })

  it('rejects malformed values, credentials, query strings and fragments', () => {
    expect(() => resolveGraphApiBase('not a url')).toThrow(/valid URL/)
    expect(() => resolveGraphApiBase('ftp://gateway.example')).toThrow(/https/)
    expect(() => resolveGraphApiBase('https://user:pass@gateway.example/v21.0')).toThrow(/credentials/)
    expect(() => resolveGraphApiBase('https://user@gateway.example/v21.0')).toThrow(/credentials/)
    expect(() => resolveGraphApiBase('https://gateway.example/v21.0?x=1')).toThrow(/query/)
    expect(() => resolveGraphApiBase('https://gateway.example/v21.0#frag')).toThrow(/query string or fragment/)
  })

  it('never falls back silently to Meta when the override is invalid', () => {
    expect(() => resolveGraphApiBase('https://')).toThrow()
  })
})
