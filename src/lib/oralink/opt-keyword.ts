/**
 * OraLink — handling of an inbound STOP / START message (CONTRACTS §5 « STOP »).
 *
 * Called by the WhatsApp webhook (`processMessage`) AFTER the idempotent
 * message insert — so a replayed delivery never reaches this code and the
 * acknowledgement is sent at most once per inbound message — and BEFORE
 * flows, automations and the AI reply, which are skipped for a handled
 * keyword (a STOP must not be captured by `collect_input`, start a flow or
 * get an AI answer).
 *
 * STOP  → `revoked` for `service` AND `marketing` (source `inbound`,
 *         evidence = the inbound wamid, never the message text), then ONE
 *         acknowledgement. A STOP from a contact already opted out is
 *         journaled again but not re-acknowledged.
 * START ❓ → only meaningful for a contact currently opted out: `granted`
 *         for each purpose currently revoked, then one acknowledgement.
 *         A START from a contact who never opted out is NOT a consent
 *         event (no consent is inferred from a bare keyword) and is left to
 *         the normal pipeline.
 *
 * The acknowledgement is the ONLY automated message allowed to bypass
 * `canSendAutomated`: it answers the opt-out itself. It is sent by the
 * private `sendAck` below and nowhere else.
 *
 * Never throws: every failure is logged and reported in the result.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { loadAccountMetaCredentials } from '@/lib/flows/meta-send'
import { supabaseAdmin } from './admin-client'
import {
  CONSENT_PURPOSES,
  getConsentState,
  isBlockedState,
  recordConsent,
  type ConsentPurpose,
} from './consent'
import type { OptKeyword } from './stop'

// ❓ Textes à valider (FR + darija) par un locuteur natif avant production
// (COORDINATION « Décisions humaines »). Aucune donnée personnelle.
export const STOP_ACK_TEXT =
  'C’est noté : vous ne recevrez plus de messages automatiques de notre part. ' +
  'Pour vous réabonner, répondez START.\n' +
  // ❓ darija — proposition à faire valider
  'تسجّل الطلب ديالك: ما غادي توصلك حتى رسالة أوتوماتيكية من عندنا. باش ترجع، صيفط START.'

export const START_ACK_TEXT =
  'C’est noté : vous êtes de nouveau abonné(e). Répondez STOP à tout moment pour arrêter.\n' +
  // ❓ darija — proposition à faire valider
  'تسجّلتي من جديد. صيفط STOP فاش ما بغيتي باش توقف.'

export interface OptKeywordInput {
  accountId: string
  contactId: string
  conversationId: string
  /** Inbound wamid — the only evidence stored. */
  wamid: string
  keyword: OptKeyword
}

export interface OptKeywordResult {
  /** true → the webhook must skip flows / automations / AI for this message. */
  handled: boolean
  recorded: boolean
  acknowledged: boolean
}

function evidenceFor(wamid: string): string {
  return `wamid:${wamid}`.slice(0, 200)
}

export async function handleInboundOptKeyword(
  input: OptKeywordInput,
  db: SupabaseClient = supabaseAdmin(),
): Promise<OptKeywordResult> {
  const { accountId, contactId, keyword } = input

  // Current state first: decides whether START applies and whether a
  // repeated STOP needs a new acknowledgement. A lookup failure on STOP
  // still records the revocation (fail towards not messaging).
  let blockedBefore: boolean | null = null
  let revokedPurposes: ConsentPurpose[] = []
  try {
    const state = await getConsentState(accountId, contactId, db)
    blockedBefore = isBlockedState(state)
    revokedPurposes = CONSENT_PURPOSES.filter((p) => state[p] === 'revoked')
  } catch (err) {
    console.error('[oralink/opt-keyword] consent state lookup failed:', err)
  }

  if (keyword === 'start') {
    // Unknown state or not opted out: not a re-subscription.
    if (blockedBefore !== true || revokedPurposes.length === 0) {
      return { handled: false, recorded: false, acknowledged: false }
    }
  }

  const purposes = keyword === 'stop' ? [...CONSENT_PURPOSES] : revokedPurposes
  const status = keyword === 'stop' ? 'revoked' : 'granted'
  try {
    await recordConsent(
      purposes.map((purpose) => ({
        accountId,
        contactId,
        purpose,
        status,
        source: 'inbound' as const,
        evidence: evidenceFor(input.wamid),
        recordedBy: null,
      })),
      db,
    )
  } catch (err) {
    // The bots stay silent for this message (handled), but no
    // acknowledgement claims an opt-out that was not recorded.
    console.error(`[oralink/opt-keyword] ${keyword} not recorded:`, err)
    return { handled: true, recorded: false, acknowledged: false }
  }

  if (keyword === 'stop' && blockedBefore === true) {
    return { handled: true, recorded: true, acknowledged: false }
  }

  const acknowledged = await sendAck(
    db,
    input,
    keyword === 'stop' ? STOP_ACK_TEXT : START_ACK_TEXT,
  )
  return { handled: true, recorded: true, acknowledged }
}

/** Unguarded on purpose (see header). Persists the bot message for the inbox. */
async function sendAck(
  db: SupabaseClient,
  input: OptKeywordInput,
  text: string,
): Promise<boolean> {
  try {
    const { data: contact, error } = await db
      .from('contacts')
      .select('id, phone, wa_user_id')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle()
    if (error || !contact) throw new Error('contact not found in account')
    const target = resolveContactSendTarget(contact)
    if (!target) throw new Error('contact has no WhatsApp address')

    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(db, input.accountId)
    const { messageId } = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: target.target,
      text,
    })

    const { error: msgErr } = await db.from('messages').insert({
      conversation_id: input.conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: text,
      message_id: messageId,
      status: 'sent',
    })
    if (msgErr) console.error('[oralink/opt-keyword] ack sent but not stored:', msgErr.message)
    return true
  } catch (err) {
    console.error('[oralink/opt-keyword] acknowledgement failed:', err)
    return false
  }
}
