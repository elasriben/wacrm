-- ============================================================
-- 900_oralink_contact_consents (OraLink — CRM MÉTIER)
--
-- Consent journal for WhatsApp contacts (CONTRACTS §5).
--
--   contact_consents         APPEND-ONLY journal. One row per consent
--                            event (granted / revoked) per purpose.
--                            Never rewritten: no UPDATE / DELETE policy
--                            for users, and a trigger refuses UPDATE for
--                            every role (sole exception: the FK action
--                            nulling recorded_by when an auth user is
--                            deleted). Rows disappear only through the
--                            ON DELETE CASCADE of their contact (right to
--                            erasure, loi 09-08) — FK actions run as the
--                            table owner, not as the deleting user.
--   contact_consent_current  VIEW: latest event per
--                            (account, contact, channel, purpose).
--                            security_invoker, so the base table's RLS
--                            applies to whoever reads it.
--
-- `evidence` holds a wamid, a flow run id or a short note — never the
-- message content.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contact_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic tiebreaker: two events recorded in the same instant
  -- (STOP then START in one webhook batch) still order deterministically.
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  purpose TEXT NOT NULL CHECK (purpose IN ('service', 'marketing')),
  status TEXT NOT NULL CHECK (status IN ('granted', 'revoked')),
  -- QR source code (CONTRACTS §6, e.g. OL-TZ-BF1) or inbound / manual / import.
  source TEXT NOT NULL CHECK (
    source IN ('inbound', 'manual', 'import')
    OR source ~ '^OL-[A-Z0-9]{2,8}-[A-Z0-9]{2,16}$'
  ),
  evidence TEXT CHECK (evidence IS NULL OR char_length(evidence) <= 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_consents_latest
  ON public.contact_consents (account_id, contact_id, channel, purpose, recorded_at DESC, seq DESC);

-- Supports the ON DELETE CASCADE from contacts (right to erasure) and the
-- per-contact guard lookups; the index above leads with account_id.
CREATE INDEX IF NOT EXISTS idx_contact_consents_contact
  ON public.contact_consents (contact_id);

ALTER TABLE public.contact_consents ENABLE ROW LEVEL SECURITY;

-- Read: any member of the account (viewer and up).
DROP POLICY IF EXISTS contact_consents_select ON public.contact_consents;
CREATE POLICY contact_consents_select ON public.contact_consents
  FOR SELECT USING (public.is_account_member(account_id));

-- Insert: agents and up, recording under their own identity, for a
-- contact they can see. The account/contact match is ALSO enforced by
-- the trigger below for every role (service_role bypasses RLS).
DROP POLICY IF EXISTS contact_consents_insert ON public.contact_consents;
CREATE POLICY contact_consents_insert ON public.contact_consents
  FOR INSERT WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND recorded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_consents.contact_id
        AND c.account_id = contact_consents.account_id
    )
  );
-- Deliberately NO update / delete policy.

-- Belt and braces on top of "no policy": users never get the privilege.
REVOKE UPDATE, DELETE, TRUNCATE ON public.contact_consents FROM anon, authenticated;

-- ------------------------------------------------------------
-- Integrity trigger: contact must belong to account_id (all roles),
-- and the journal is never rewritten (UPDATE refused for all roles).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.oralink_consent_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Single exception: the FK action `recorded_by … ON DELETE SET NULL`
    -- (an auth user is deleted) is itself an UPDATE and fires this
    -- trigger. Refusing it would make every user who ever recorded a
    -- consent undeletable. Only that exact change is let through:
    -- recorded_by goes from a value to NULL and nothing else moves.
    IF OLD.recorded_by IS NOT NULL
       AND NEW.recorded_by IS NULL
       AND (to_jsonb(NEW) - 'recorded_by') = (to_jsonb(OLD) - 'recorded_by') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'contact_consents is append-only'
      USING ERRCODE = '42501';
  END IF;
  -- The journal records WHEN the event was recorded, not a caller-chosen
  -- date: a back-dated row could otherwise override the current state.
  NEW.recorded_at := now();
  IF NOT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'contact does not belong to account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.oralink_consent_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.oralink_consent_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS oralink_consent_guard ON public.contact_consents;
CREATE TRIGGER oralink_consent_guard
  BEFORE INSERT OR UPDATE ON public.contact_consents
  FOR EACH ROW EXECUTE FUNCTION public.oralink_consent_guard();

-- ------------------------------------------------------------
-- Current state: latest event per (account, contact, channel, purpose).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.contact_consent_current
WITH (security_invoker = true) AS
SELECT DISTINCT ON (account_id, contact_id, channel, purpose)
  account_id, contact_id, channel, purpose, status, source, evidence,
  recorded_at, recorded_by, id AS consent_id
FROM public.contact_consents
ORDER BY account_id, contact_id, channel, purpose, recorded_at DESC, seq DESC;

REVOKE ALL ON public.contact_consent_current FROM anon;
GRANT SELECT ON public.contact_consent_current TO authenticated, service_role;
