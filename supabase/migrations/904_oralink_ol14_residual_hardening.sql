-- OraLink : correctifs résiduels de l'audit OL-14 (après 903).
--
-- Migration additive : 900, 901 et 902 ne sont pas modifiées. Trois points :
--
--  A. Privilèges de table sur lead_scores et contact_consents.
--     Les privilèges par défaut du schéma public (Supabase et standalone-bootstrap.sql)
--     donnent ALL à anon, authenticated et service_role. TRUNCATE ne passe pas par la
--     RLS : un utilisateur authentifié pouvait vider lead_scores pour TOUS les comptes.
--     TRIGGER permettait de poser un déclencheur (fonction pg_temp) exécuté par les
--     écritures des autres rôles. REFERENCES n'a pas d'usage légitime hors propriétaire.
--     On retire TRUNCATE, TRIGGER et REFERENCES à anon, authenticated et service_role
--     (le code n'en fait aucun usage ; le propriétaire garde tout pour les migrations),
--     et toute écriture à anon (les politiques la refusaient déjà). SELECT reste à anon :
--     lui retirer ferait passer ses lectures de « 0 ligne » à une erreur (décision séparée,
--     même raisonnement que 903).
--
--  B. public.redeem_invitation(text) (dernière définition : 902).
--     search_path = public sans pg_temp : le schéma temporaire de la session était
--     consulté EN PREMIER, une table temporaire account_invitations fabriquée permettait
--     de rejoindre n'importe quel compte comme owner. search_path figé à
--     `pg_catalog, pg_temp` (pg_temp en dernier), toutes les références qualifiées,
--     EXECUTE retiré à PUBLIC et anon (la route appelle la RPC avec la session
--     utilisateur). Contrôles métier, codes d'erreur et vérification des données
--     strictement identiques à 902. Propriétaire non imposé (CREATE OR REPLACE le
--     conserve) ; garde : il doit contourner la RLS des tables lues, sinon arrêt.
--
--  C. Ordre de contact_consent_current.
--     recorded_at valait now() (début de TRANSACTION) : un STOP inséré après un opt-in
--     concurrent, mais dans une transaction commencée avant, était supplanté par cet
--     opt-in. seq pouvait être imposé (OVERRIDING SYSTEM VALUE, permis à tout rôle ayant
--     INSERT) et dupliqué, d'où des égalités parfaites départagées arbitrairement.
--     Désormais le déclencheur attribue lui-même seq (nextval) et recorded_at
--     (clock_timestamp()) à l'insertion, seq est unique, et la vue retient la ligne de
--     plus grand seq : la dernière décision insérée gagne toujours, aucune égalité
--     n'est possible. Arrêt explicite si des doublons de seq existent déjà.
--     Limites (transactions concurrentes) : l'ordre retenu est celui d'exécution des
--     INSERT (nextval), pas celui des COMMIT ni l'horodatage du message WhatsApp. Un
--     STOP et un START reçus dans le désordre, ou un STOP rejoué par un nouvel envoi du
--     webhook après un START, sont départagés par leur ordre de réception. En lecture
--     validée (READ COMMITTED), un contrôle d'envoi exécuté avant le COMMIT d'un STOP ne
--     le voit pas encore. recorded_at reste informatif : entre deux sessions, il peut
--     différer de l'ordre de seq de quelques microsecondes.
--
-- Réexécutable : gardes en lecture seule, REVOKE / GRANT, CREATE OR REPLACE, IF NOT EXISTS.
-- Tests : oralink/crm/tests/ol14-residual.sql, run-ol14-residual-mutations.sh.

-- ------------------------------------------------------------
-- Gardes (lecture seule) : rien n'est modifié si l'une échoue.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_fn regprocedure := to_regprocedure('public.redeem_invitation(text)');
  v_owner oid;
  v_bypass boolean;
  v_bad text;
  v_dups bigint;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '904: public.redeem_invitation(text) absente (047/902 non appliquées ?)';
  END IF;
  SELECT proowner INTO v_owner FROM pg_proc WHERE oid = v_fn;
  SELECT rolsuper OR rolbypassrls INTO v_bypass FROM pg_roles WHERE oid = v_owner;
  IF NOT v_bypass THEN
    -- Sans BYPASSRLS, la fonction ne lit ces tables sans RLS que si elle en est
    -- propriétaire et que FORCE ROW LEVEL SECURITY est inactif.
    SELECT string_agg(c.oid::regclass::text, ', ') INTO v_bad
      FROM pg_class c
     WHERE c.oid IN ('public.account_invitations'::regclass, 'public.profiles'::regclass, 'public.accounts'::regclass)
       AND (c.relowner <> v_owner OR c.relforcerowsecurity);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION '904: le propriétaire de redeem_invitation (%) ne contourne pas la RLS de % : arrêt, à examiner avant migration',
        pg_get_userbyid(v_owner), v_bad;
    END IF;
  END IF;

  SELECT count(*) INTO v_dups FROM (
    SELECT seq FROM public.contact_consents GROUP BY seq HAVING count(*) > 1
  ) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION '904: % valeur(s) de contact_consents.seq en double : arrêt, à départager manuellement avant migration', v_dups;
  END IF;
END $$;

-- ------------------------------------------------------------
-- A. Privilèges de table
-- ------------------------------------------------------------
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.lead_scores      FROM anon, authenticated, service_role;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.contact_consents FROM anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE        ON public.lead_scores      FROM anon;
REVOKE INSERT, UPDATE, DELETE        ON public.contact_consents FROM anon;

-- ------------------------------------------------------------
-- B. redeem_invitation : même logique que 902, noms qualifiés
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv public.account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM public.account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.contact_consents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM public.lead_scores WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE public.profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE public.account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM public.accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- C. contact_consents : seq attribué à l'insertion, unique, seul critère d'ordre
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS contact_consents_seq_key
  ON public.contact_consents (seq);

CREATE INDEX IF NOT EXISTS idx_contact_consents_latest_seq
  ON public.contact_consents (account_id, contact_id, channel, purpose, seq DESC);

CREATE OR REPLACE FUNCTION public.oralink_consent_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Single exception (unchanged from 900): the FK action
    -- `recorded_by … ON DELETE SET NULL` when an auth user is deleted.
    IF OLD.recorded_by IS NOT NULL
       AND NEW.recorded_by IS NULL
       AND (to_jsonb(NEW) - 'recorded_by') = (to_jsonb(OLD) - 'recorded_by') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'contact_consents is append-only'
      USING ERRCODE = '42501';
  END IF;
  -- Order of events = order of insertion, decided here and nowhere else:
  -- a caller-supplied seq (OVERRIDING SYSTEM VALUE) or date is discarded,
  -- and clock_timestamp() (not now(), the transaction start) keeps
  -- recorded_at consistent with seq across concurrent transactions.
  NEW.seq := nextval(pg_get_serial_sequence('public.contact_consents', 'seq')::regclass);
  NEW.recorded_at := clock_timestamp();
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
REVOKE ALL ON FUNCTION public.oralink_consent_guard() FROM PUBLIC, anon, authenticated;

-- Same columns as 900 (CREATE OR REPLACE keeps grants and security_invoker).
CREATE OR REPLACE VIEW public.contact_consent_current
WITH (security_invoker = true) AS
SELECT DISTINCT ON (account_id, contact_id, channel, purpose)
  account_id, contact_id, channel, purpose, status, source, evidence,
  recorded_at, recorded_by, id AS consent_id
FROM public.contact_consents
ORDER BY account_id, contact_id, channel, purpose, seq DESC;
