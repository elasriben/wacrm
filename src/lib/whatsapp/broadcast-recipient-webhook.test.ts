import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BROADCAST_REPLY_WINDOW_MS,
  applyBroadcastRecipientStatus,
  flagBroadcastReply,
  isReplyAttributable,
} from './broadcast-recipient-webhook';

interface FakeRow {
  id: string;
  status: string;
  sent_at: string | null;
  whatsapp_message_id?: string;
  /** Owning account of the row's broadcast (broadcasts.account_id). */
  account_id?: string;
}

type Filters = Record<string, unknown>;

/**
 * Supabase-shaped fake for broadcast_recipients. It models the inner join
 * on broadcasts.account_id (rows without account_id belong to 'acc-1') and
 * applies every eq / in filter it is given, so a query that forgets the
 * account filter (or the `!inner` embed) really does match other accounts'
 * rows.
 *
 * `beforeUpdate` runs between the read and the write (concurrency tests).
 */
function makeDb(
  rows: FakeRow[],
  options: { failUpdate?: boolean; failSelect?: boolean; beforeUpdate?: () => void } = {}
) {
  const updates: { filters: Filters; allowed: string[]; patch: Record<string, unknown> }[] = [];
  const selects: { columns: string; filters: Filters }[] = [];
  const latestQuery: Record<string, unknown> = {};
  const accountOf = (r: FakeRow) => r.account_id ?? 'acc-1';
  // `inner`: like real PostgREST, a filter on an embedded resource
  // (broadcasts.account_id) only restricts the parent rows when the embed
  // is `!inner`; without it the filter is silently ignored.
  const matches = (r: FakeRow, filters: Filters, inner = true) =>
    Object.entries(filters).every(([col, val]) => {
      if (col === 'broadcasts.account_id' && !inner) return true;
      // flagBroadcastReply filters on contact_id; each fake holds one contact.
      if (col === 'contact_id') return true;
      const actual =
        col === 'broadcasts.account_id'
          ? accountOf(r)
          : col === 'id'
            ? r.id
            : col === 'status'
              ? r.status
              : col === 'whatsapp_message_id'
                ? r.whatsapp_message_id
                : undefined;
      return Array.isArray(val) ? val.includes(actual) : actual === val;
    });

  const db = {
    from(table: string) {
      expect(table).toBe('broadcast_recipients');
      return {
        select: (columns: string) => {
          latestQuery.columns = columns;
          const filters: Filters = {};
          selects.push({ columns, filters });
          const result = () =>
            options.failSelect
              ? { data: null, error: { message: 'select boom' } }
              : { data: rows.filter((r) => matches(r, filters, columns.includes('broadcasts!inner('))).map((r) => ({ ...r })), error: null };
          const chain = {
            eq: (column: string, value: unknown) => {
              latestQuery[column] = value;
              filters[column] = value;
              return chain;
            },
            in: (column: string, values: unknown[]) => {
              filters[column] = values;
              return chain;
            },
            order: (column: string, opts: { ascending: boolean }) => {
              latestQuery.order = [column, opts.ascending];
              return chain;
            },
            limit: (n: number) => {
              const r = result();
              return Promise.resolve({ ...r, data: r.data ? r.data.slice(0, n) : r.data });
            },
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              Promise.resolve(result()).then(res, rej),
          };
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          options.beforeUpdate?.();
          const filters: Filters = {};
          let allowed: string[] = [];
          const chain = {
            eq: (column: string, value: unknown) => {
              filters[column] = value;
              return chain;
            },
            in: (column: string, values: string[]) => {
              if (column === 'status') allowed = values;
              else filters[column] = values;
              return chain;
            },
            select: () => {
              updates.push({ filters: { ...filters }, allowed, patch });
              if (options.failUpdate) {
                return Promise.resolve({ data: null, error: { message: 'boom' } });
              }
              const hit = rows.filter((r) => matches(r, filters) && allowed.includes(r.status));
              for (const r of hit) r.status = String(patch.status);
              return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
            },
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, updates, selects, latestQuery };
}

const NOW = new Date('2026-10-16T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

describe('applyBroadcastRecipientStatus', () => {
  const event = (status: string) => ({
    whatsappMessageId: 'wamid.1',
    status,
    occurredAt: '2026-10-16T11:00:00.000Z',
    failure: null,
  });

  it('only updates rows whose current status may precede the incoming one', async () => {
    const { db, updates, selects } = makeDb([
      { id: 'r1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1' },
    ]);
    await expect(applyBroadcastRecipientStatus(db, 'acc-1', event('read'))).resolves.toBe('updated');
    expect(selects[0]).toEqual({
      columns: 'id, broadcasts!inner(account_id)',
      filters: {
        whatsapp_message_id: 'wamid.1',
        'broadcasts.account_id': 'acc-1',
        status: ['pending', 'sent', 'delivered'],
      },
    });
    expect(updates[0].filters).toEqual({ id: ['r1'] });
    expect(updates[0].allowed).toEqual(['pending', 'sent', 'delivered']);
    expect(updates[0].patch).toEqual({ status: 'read', read_at: '2026-10-16T11:00:00.000Z' });
  });

  it('is a no-op when a concurrent webhook already advanced the row', async () => {
    const rows = [{ id: 'r1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1' }];
    const { db } = makeDb(rows);
    await applyBroadcastRecipientStatus(db, 'acc-1', event('read'));
    await expect(applyBroadcastRecipientStatus(db, 'acc-1', event('delivered'))).resolves.toBe('skipped');
    expect(rows[0].status).toBe('read');
  });

  it('does not overwrite a row whose status changed between the read and the update', async () => {
    const rows = [{ id: 'r1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1' }];
    const { db, updates } = makeDb(rows, {
      beforeUpdate: () => {
        rows[0].status = 'read'; // a concurrent "read" webhook lands first
      },
    });
    await expect(applyBroadcastRecipientStatus(db, 'acc-1', event('delivered'))).resolves.toBe('skipped');
    expect(updates).toHaveLength(1);
    expect(updates[0].allowed).toEqual(['pending', 'sent']);
    expect(rows[0].status).toBe('read');
  });

  it('refuses failed once the recipient was delivered', async () => {
    const rows = [{ id: 'r1', status: 'delivered', sent_at: null, whatsapp_message_id: 'wamid.1' }];
    const { db, updates, selects } = makeDb(rows);
    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', {
        ...event('failed'),
        failure: { code: 131049, title: 'Blocked', details: 'ecosystem' },
      })
    ).resolves.toBe('skipped');
    expect(selects[0].filters.status).toEqual(['pending', 'sent']);
    expect(updates).toHaveLength(0);
    expect(rows[0].status).toBe('delivered');
  });

  it("folds Meta's failure reason into error_message", async () => {
    const rows = [{ id: 'r1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1' }];
    const { db, updates } = makeDb(rows);
    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', {
        ...event('failed'),
        failure: { code: 131049, title: 'Blocked', details: 'ecosystem' },
      })
    ).resolves.toBe('updated');
    expect(updates[0].allowed).toEqual(['pending', 'sent']);
    expect(updates[0].patch.error_message).toBe('[131049] Blocked: ecosystem');
    expect(rows[0].status).toBe('failed');
  });

  it('skips unknown statuses without touching the database', async () => {
    const { db, updates, selects } = makeDb([]);
    await expect(applyBroadcastRecipientStatus(db, 'acc-1', event('deleted'))).resolves.toBe('skipped');
    expect(selects).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('skips without any query when no account is given', async () => {
    const rows = [{ id: 'r1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1' }];
    const { db, updates, selects } = makeDb(rows);
    await expect(applyBroadcastRecipientStatus(db, '', event('read'))).resolves.toBe('skipped');
    expect(selects).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(rows[0].status).toBe('sent');
  });

  // N2 — the real flaw: a webhook resolved for account A carries the wamid
  // of a row belonging to a broadcast of account B. Covered for every
  // target status that can move a 'sent' row.
  it.each(['delivered', 'read', 'failed'])(
    "N2: a status resolved for A never moves B's row carrying the wamid (target %s)",
    async (target) => {
      const rows = [
        { id: 'b1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1', account_id: 'acc-B' },
      ];
      const { db, updates } = makeDb(rows);
      await expect(applyBroadcastRecipientStatus(db, 'acc-A', event(target))).resolves.toBe('skipped');
      expect(updates).toHaveLength(0);
      expect(rows[0].status).toBe('sent');
    }
  );

  it.each(['delivered', 'read', 'failed'])(
    'P2: the owning account moves its own row (target %s)',
    async (target) => {
      const rows = [
        { id: 'a1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1', account_id: 'acc-A' },
      ];
      const { db } = makeDb(rows);
      await expect(applyBroadcastRecipientStatus(db, 'acc-A', event(target))).resolves.toBe('updated');
      expect(rows[0].status).toBe(target);
    }
  );

  it('uses an !inner embed: without it PostgREST ignores the account filter', async () => {
    const rows = [
      { id: 'b1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1', account_id: 'acc-B' },
    ];
    const { db, selects } = makeDb(rows);
    await applyBroadcastRecipientStatus(db, 'acc-A', event('read'));
    expect(selects[0].columns).toContain('broadcasts!inner(account_id)');
    expect(selects[0].filters['broadcasts.account_id']).toBe('acc-A');
    // Sanity check of the fake itself: the same filter WITHOUT !inner leaks B's row.
    const leaky = await (db
      .from('broadcast_recipients')
      .select('id, broadcasts(account_id)')
      .eq('whatsapp_message_id', 'wamid.1')
      .eq('broadcasts.account_id', 'acc-A') as unknown as Promise<{ data: { id: string }[] }>);
    expect(leaky.data.map((r) => r.id)).toEqual(['b1']);
  });

  // Defence in depth only: idx_broadcast_recipients_wamid (migration 003) is
  // UNIQUE over the whole table, so the same wamid cannot exist in two
  // accounts with the current schema. Kept in the fake in case that index
  // ever changes.
  it("same wamid in two accounts (impossible today) → only the resolved account's row changes", async () => {
    const rows = [
      { id: 'a1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1', account_id: 'acc-A' },
      { id: 'b1', status: 'sent', sent_at: null, whatsapp_message_id: 'wamid.1', account_id: 'acc-B' },
    ];
    const { db, updates } = makeDb(rows);
    await expect(applyBroadcastRecipientStatus(db, 'acc-A', event('read'))).resolves.toBe('updated');
    expect(updates[0].filters).toEqual({ id: ['a1'] });
    expect(rows.map((r) => r.status)).toEqual(['read', 'sent']);
  });

  it('reports a database error on the update', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [{ id: 'r1', status: 'pending', sent_at: null, whatsapp_message_id: 'wamid.1' }];
    const { db } = makeDb(rows, { failUpdate: true });
    await expect(applyBroadcastRecipientStatus(db, 'acc-1', event('sent'))).resolves.toBe('error');
    error.mockRestore();
  });

  it('reports a database error on the bounded read, without updating', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [{ id: 'r1', status: 'pending', sent_at: null, whatsapp_message_id: 'wamid.1' }];
    const { db, updates } = makeDb(rows, { failSelect: true });
    await expect(applyBroadcastRecipientStatus(db, 'acc-1', event('sent'))).resolves.toBe('error');
    expect(updates).toHaveLength(0);
    error.mockRestore();
  });
});

describe('isReplyAttributable', () => {
  it('accepts a sent, delivered or read row inside the reply window', () => {
    for (const status of ['sent', 'delivered', 'read']) {
      expect(isReplyAttributable({ id: 'r', status, sent_at: hoursAgo(2) }, NOW)).toBe(true);
    }
  });

  it('rejects a row already replied, failed, or never sent', () => {
    expect(isReplyAttributable({ id: 'r', status: 'replied', sent_at: hoursAgo(2) }, NOW)).toBe(false);
    expect(isReplyAttributable({ id: 'r', status: 'failed', sent_at: hoursAgo(2) }, NOW)).toBe(false);
    expect(isReplyAttributable({ id: 'r', status: 'pending', sent_at: null }, NOW)).toBe(false);
  });

  it('rejects a row sent before the reply window', () => {
    const justOutside = new Date(NOW.getTime() - BROADCAST_REPLY_WINDOW_MS - 1).toISOString();
    expect(isReplyAttributable({ id: 'r', status: 'read', sent_at: justOutside }, NOW)).toBe(false);
  });
});

describe('flagBroadcastReply', () => {
  it('looks up only the most recent recipient row for the contact in the account', async () => {
    const { db, latestQuery } = makeDb([{ id: 'r1', status: 'read', sent_at: hoursAgo(1) }]);
    await expect(flagBroadcastReply(db, 'acc-1', 'contact-1', NOW)).resolves.toBe('updated');
    expect(latestQuery).toMatchObject({
      contact_id: 'contact-1',
      'broadcasts.account_id': 'acc-1',
      order: ['created_at', false],
    });
  });

  it('does not walk back to an older broadcast on a second inbound message', async () => {
    const rows = [
      { id: 'newest', status: 'read', sent_at: hoursAgo(1) },
      { id: 'older', status: 'read', sent_at: hoursAgo(30) },
    ];
    const { db } = makeDb(rows);
    await flagBroadcastReply(db, 'acc-1', 'contact-1', NOW);
    await expect(flagBroadcastReply(db, 'acc-1', 'contact-1', NOW)).resolves.toBe('skipped');
    expect(rows.map((r) => r.status)).toEqual(['replied', 'read']);
  });

  it('ignores a reply to a broadcast sent outside the window', async () => {
    const rows = [{ id: 'r1', status: 'delivered', sent_at: hoursAgo(24 * 8) }];
    const { db, updates } = makeDb(rows);
    await expect(flagBroadcastReply(db, 'acc-1', 'contact-1', NOW)).resolves.toBe('skipped');
    expect(updates).toHaveLength(0);
  });

  it('guards the update so a concurrent reply cannot flag it twice', async () => {
    const { db, updates } = makeDb([{ id: 'r1', status: 'sent', sent_at: hoursAgo(1) }]);
    await flagBroadcastReply(db, 'acc-1', 'contact-1', NOW);
    expect(updates[0].filters).toEqual({ id: 'r1' });
    expect(updates[0].allowed).not.toContain('replied');
    expect(updates[0].patch).toEqual({ status: 'replied', replied_at: NOW.toISOString() });
  });
});
