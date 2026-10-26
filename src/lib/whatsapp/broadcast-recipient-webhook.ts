import type { SupabaseClient } from '@supabase/supabase-js';

import { allowedPredecessors, isRecipientStatus } from '@/lib/broadcast-status';

export const BROADCAST_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecipientStatusFailure {
  code: number;
  title: string;
  details: string | null;
}

export interface RecipientStatusEvent {
  whatsappMessageId: string;
  status: string;
  occurredAt: string;
  failure: RecipientStatusFailure | null;
}

export type RecipientStatusOutcome = 'updated' | 'skipped' | 'error';

function failureMessage(failure: RecipientStatusFailure): string {
  return (
    `[${failure.code}] ${failure.title}` +
    (failure.details ? `: ${failure.details}` : '')
  );
}

export async function applyBroadcastRecipientStatus(
  db: SupabaseClient,
  // Account resolved from the receiving number (metadata.phone_number_id).
  // Required: a status must never move a recipient row of another
  // account, even if it carries the same wamid. Empty → skipped, no query.
  accountId: string,
  event: RecipientStatusEvent
): Promise<RecipientStatusOutcome> {
  if (!accountId) return 'skipped';
  if (!isRecipientStatus(event.status)) return 'skipped';
  const predecessors = allowedPredecessors(event.status);
  if (predecessors.length === 0) return 'skipped';

  const update: Record<string, unknown> = { status: event.status };
  if (event.status === 'sent') update.sent_at = event.occurredAt;
  if (event.status === 'delivered') update.delivered_at = event.occurredAt;
  if (event.status === 'read') update.read_at = event.occurredAt;
  if (event.failure) update.error_message = failureMessage(event.failure);

  // 1) Bounded read: rows of THIS account's broadcasts only (inner join on
  //    broadcasts.account_id), same pattern as flagBroadcastReply below.
  const { data: rows, error: selectError } = await db
    .from('broadcast_recipients')
    .select('id, broadcasts!inner(account_id)')
    .eq('whatsapp_message_id', event.whatsappMessageId)
    .eq('broadcasts.account_id', accountId)
    .in('status', predecessors);

  if (selectError) {
    console.error('Error fetching broadcast recipients for status:', selectError);
    return 'error';
  }
  const ids = ((rows ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return 'skipped';

  // 2) Update by id, re-checking the predecessor statuses so a concurrent
  //    webhook that advanced a row between the read and the write is not
  //    overwritten.
  const { data, error } = await db
    .from('broadcast_recipients')
    .update(update)
    .in('id', ids)
    .in('status', predecessors)
    .select('id');

  if (error) {
    console.error('Error updating broadcast recipient status:', error);
    return 'error';
  }
  return data && data.length > 0 ? 'updated' : 'skipped';
}

interface LatestBroadcastRecipient {
  id: string;
  status: string;
  sent_at: string | null;
}

export function isReplyAttributable(
  recipient: LatestBroadcastRecipient,
  now: Date
): boolean {
  if (!isRecipientStatus(recipient.status)) return false;
  if (!allowedPredecessors('replied').includes(recipient.status)) return false;
  if (!recipient.sent_at) return false;
  const sentAt = Date.parse(recipient.sent_at);
  if (Number.isNaN(sentAt)) return false;
  return now.getTime() - sentAt <= BROADCAST_REPLY_WINDOW_MS;
}

export async function flagBroadcastReply(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  now: Date = new Date()
): Promise<RecipientStatusOutcome> {
  const { data: rows, error } = await db
    .from('broadcast_recipients')
    .select('id, status, sent_at, broadcasts!inner(account_id)')
    .eq('contact_id', contactId)
    .eq('broadcasts.account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('Error fetching latest broadcast recipient:', error);
    return 'error';
  }
  const latest = (rows?.[0] ?? null) as LatestBroadcastRecipient | null;
  if (!latest || !isReplyAttributable(latest, now)) return 'skipped';

  const { data: updated, error: updateError } = await db
    .from('broadcast_recipients')
    .update({ status: 'replied', replied_at: now.toISOString() })
    .eq('id', latest.id)
    .in('status', allowedPredecessors('replied'))
    .select('id');

  if (updateError) {
    console.error('Error marking broadcast recipient replied:', updateError);
    return 'error';
  }
  return updated && updated.length > 0 ? 'updated' : 'skipped';
}
