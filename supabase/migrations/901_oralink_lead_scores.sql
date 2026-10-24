-- ============================================================
-- 901_oralink_lead_scores (OraLink — CRM MÉTIER)
--
-- Explainable lead score (CONTRACTS §5). One CURRENT row per contact,
-- overwritten on every recompute. `reasons` is the list returned by
-- src/lib/oralink/scoring.ts → scoreLead():
--   [{ "rule": "<rule id>", "points": <int>, "valeur": <answer> }, …]
-- `rules_version` is the `version` of oralink/crm/scoring/<compte>.json
-- that produced the score, so a score can always be re-explained.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.lead_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  rules_version TEXT NOT NULL CHECK (char_length(rules_version) BETWEEN 1 AND 64),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_scores_account_score
  ON public.lead_scores (account_id, score DESC);

ALTER TABLE public.lead_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_scores_select ON public.lead_scores;
CREATE POLICY lead_scores_select ON public.lead_scores
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS lead_scores_insert ON public.lead_scores;
CREATE POLICY lead_scores_insert ON public.lead_scores
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS lead_scores_update ON public.lead_scores;
CREATE POLICY lead_scores_update ON public.lead_scores
  FOR UPDATE USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS lead_scores_delete ON public.lead_scores;
CREATE POLICY lead_scores_delete ON public.lead_scores
  FOR DELETE USING (public.is_account_member(account_id, 'agent'));

-- Contact must belong to account_id, for every role (service_role
-- bypasses RLS). Without it an agent of account A could attach a score
-- row in A to a contact UUID of account B.
CREATE OR REPLACE FUNCTION public.oralink_lead_score_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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
ALTER FUNCTION public.oralink_lead_score_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.oralink_lead_score_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS oralink_lead_score_guard ON public.lead_scores;
CREATE TRIGGER oralink_lead_score_guard
  BEFORE INSERT OR UPDATE ON public.lead_scores
  FOR EACH ROW EXECUTE FUNCTION public.oralink_lead_score_guard();
