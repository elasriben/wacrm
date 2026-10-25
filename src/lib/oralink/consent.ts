/**
 * OraLink — consent journal helpers and the outbound guard (CONTRACTS §5).
 *
 * `canSendAutomated(accountId, contactId)` is the SINGLE entry point every
 * automated outbound path (broadcast, flows, automations, AI auto-reply)
 * must call before sending. Manual replies typed by a human agent in the
 * inbox are not automated and are not gated.
 *
 * Semantics
 *   - Reads `contact_consent_current` (migration 900_oralink_contact_consents): latest event per
 *     (account, contact, channel, purpose).
 *   - Blocked when the latest WhatsApp event for ANY purpose is `revoked`.
 *     STOP revokes both purposes, so in practice this is "the contact said
 *     STOP and has not said START since". A marketing-only revocation
 *     (manual / import) also blocks every automated send: the guard has no
 *     purpose argument and errs on the side of not messaging.
 *   - No event at all → allowed (status quo for contacts that predate the
 *     journal).
 *   - Lookup error → BLOCKED (fail closed) and logged. A broken guard must
 *     not turn into "send to everyone".
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'

export type ConsentPurpose = 'service' | 'marketing'
export type ConsentStatus = 'granted' | 'revoked'
export const CONSENT_PURPOSES: readonly ConsentPurpose[] = ['service', 'marketing']

/** `inbound` | `manual` | `import` or a QR source code (CONTRACTS §6). */
export type ConsentSource = 'inbound' | 'manual' | 'import' | `OL-${string}`

const SOURCE_CODE = /^OL-[A-Z0-9]{2,8}-[A-Z0-9]{2,16}$/

export interface ConsentEventInput {
  accountId: string
  contactId: string
  purpose: ConsentPurpose
  status: ConsentStatus
  source: ConsentSource
  /** wamid, flow run id or a short note — NEVER message content. ≤ 200 chars. */
  evidence?: string | null
  /** auth user id of the human who recorded it; null for system events. */
  recordedBy?: string | null
}

export class ConsentError extends Error {}

function assertValidEvent(e: ConsentEventInput): void {
  if (!e.accountId || !e.contactId) throw new ConsentError('accountId and contactId are required')
  if (!CONSENT_PURPOSES.includes(e.purpose)) throw new ConsentError(`invalid purpose: ${e.purpose}`)
  if (e.status !== 'granted' && e.status !== 'revoked') {
    throw new ConsentError(`invalid status: ${e.status}`)
  }
  const s = e.source as string
  if (!(s === 'inbound' || s === 'manual' || s === 'import' || SOURCE_CODE.test(s))) {
    throw new ConsentError(`invalid source: ${s}`)
  }
  if (e.evidence != null && e.evidence.length > 200) {
    throw new ConsentError('evidence too long (max 200 chars, no message content)')
  }
}

/**
 * Append one or more events to the journal. Throws ConsentError on invalid
 * input or when the insert fails (callers decide whether that is fatal).
 */
export async function recordConsent(
  events: ConsentEventInput | ConsentEventInput[],
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  const list = Array.isArray(events) ? events : [events]
  if (list.length === 0) return
  list.forEach(assertValidEvent)
  const { error } = await db.from('contact_consents').insert(
    list.map((e) => ({
      account_id: e.accountId,
      contact_id: e.contactId,
      channel: 'whatsapp',
      purpose: e.purpose,
      status: e.status,
      source: e.source,
      evidence: e.evidence ?? null,
      recorded_by: e.recordedBy ?? null,
    })),
  )
  if (error) throw new ConsentError(`recordConsent failed: ${error.message}`)
}

export type ConsentState = Partial<Record<ConsentPurpose, ConsentStatus>>

/** Current state per purpose for one contact. Throws on lookup error. */
export async function getConsentState(
  accountId: string,
  contactId: string,
  db: SupabaseClient = supabaseAdmin(),
): Promise<ConsentState> {
  const { data, error } = await db
    .from('contact_consent_current')
    .select('purpose, status')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('channel', 'whatsapp')
  if (error) throw new ConsentError(`consent lookup failed: ${error.message}`)
  const state: ConsentState = {}
  for (const row of (data ?? []) as { purpose: ConsentPurpose; status: ConsentStatus }[]) {
    state[row.purpose] = row.status
  }
  return state
}

export function isBlockedState(state: ConsentState): boolean {
  return Object.values(state).some((s) => s === 'revoked')
}

/**
 * THE outbound guard. true = an automated message may be sent to this
 * contact. Never throws; fails closed.
 */
export async function canSendAutomated(
  accountId: string,
  contactId: string,
  db: SupabaseClient = supabaseAdmin(),
): Promise<boolean> {
  try {
    return !isBlockedState(await getConsentState(accountId, contactId, db))
  } catch (err) {
    console.error('[oralink/consent] guard lookup failed — blocking send:', err)
    return false
  }
}

/** Error thrown by guarded senders so engines log a clear failure reason. */
export class ConsentBlockedError extends Error {
  constructor(contactId: string) {
    super(`automated send blocked: contact ${contactId} has opted out (STOP)`)
    this.name = 'ConsentBlockedError'
  }
}

/** Throws ConsentBlockedError unless canSendAutomated() allows the send. */
export async function assertCanSendAutomated(
  accountId: string,
  contactId: string,
  db?: SupabaseClient,
): Promise<void> {
  if (!(await canSendAutomated(accountId, contactId, db))) {
    throw new ConsentBlockedError(contactId)
  }
}

const IN_CHUNK = 200

/**
 * Batch form of the guard for fan-out paths (broadcasts): returns the ids,
 * among `contactIds`, that must NOT receive an automated message. Same rule
 * as canSendAutomated. Throws on lookup error so the caller can fail closed
 * for the whole batch.
 */
export async function blockedContactIds(
  accountId: string,
  contactIds: readonly string[],
  db: SupabaseClient = supabaseAdmin(),
): Promise<Set<string>> {
  const blocked = new Set<string>()
  const unique = [...new Set(contactIds.filter(Boolean))]
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK)
    const { data, error } = await db
      .from('contact_consent_current')
      .select('contact_id')
      .eq('account_id', accountId)
      .eq('channel', 'whatsapp')
      .eq('status', 'revoked')
      .in('contact_id', chunk)
    if (error) throw new ConsentError(`consent lookup failed: ${error.message}`)
    for (const row of (data ?? []) as { contact_id: string }[]) blocked.add(row.contact_id)
  }
  return blocked
}

/**
 * Phone-keyed batch guard, for the legacy broadcast route that only has
 * phone numbers. Matches contacts of the account on `phone_normalized`
 * (digits only, migration 022). Returns the DIGITS-ONLY phones to skip.
 * A phone with no contact row has no consent history and is not blocked.
 */
export async function blockedPhones(
  accountId: string,
  phones: readonly string[],
  db: SupabaseClient = supabaseAdmin(),
): Promise<Set<string>> {
  const digits = [...new Set(phones.map((p) => p.replace(/\D/g, '')).filter(Boolean))]
  const contactByPhone = new Map<string, string[]>()
  for (let i = 0; i < digits.length; i += IN_CHUNK) {
    const chunk = digits.slice(i, i + IN_CHUNK)
    const { data, error } = await db
      .from('contacts')
      .select('id, phone_normalized')
      .eq('account_id', accountId)
      .in('phone_normalized', chunk)
    if (error) throw new ConsentError(`contact lookup failed: ${error.message}`)
    for (const row of (data ?? []) as { id: string; phone_normalized: string }[]) {
      const ids = contactByPhone.get(row.phone_normalized) ?? []
      ids.push(row.id)
      contactByPhone.set(row.phone_normalized, ids)
    }
  }
  const allIds = [...contactByPhone.values()].flat()
  if (allIds.length === 0) return new Set()
  const blockedIds = await blockedContactIds(accountId, allIds, db)
  const out = new Set<string>()
  for (const [phone, ids] of contactByPhone) {
    if (ids.some((id) => blockedIds.has(id))) out.add(phone)
  }
  return out
}
