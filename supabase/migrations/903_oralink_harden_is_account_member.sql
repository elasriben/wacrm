-- OraLink : durcissement de public.is_account_member (revue défensive, OL-14).
--
-- Migration additive : la 017 n'est pas modifiée. Même signature, même valeur par
-- défaut, même logique, même propriétaire, toujours SECURITY DEFINER : les politiques
-- RLS qui appellent la fonction (115 politiques sur 36 tables au moment de l'écriture :
-- 017, 024, 026, 028–030, 033, 035, 900, 901) et la RPC replace_flow_nodes (052)
-- continuent de fonctionner sans être recréées.
--
-- Ce qui change :
--  1. search_path figé à `pg_catalog, pg_temp` (pg_temp EN DERNIER : sans mention
--     explicite, le schéma temporaire de la session serait consulté en premier pour
--     les noms de tables non qualifiés) au lieu de `public`, et toutes les références
--     qualifiées (public.profiles, auth.uid(), public.account_role_enum).
--  2. EXECUTE retiré à PUBLIC (droit implicite accordé à la création), puis redonné
--     explicitement aux rôles qui évaluent les politiques. `anon` est conservé
--     provisoirement : les politiques n'ont pas de clause TO, le lui retirer ferait
--     passer les lectures anonymes de « 0 ligne » à une erreur 42501 (décision séparée).
--  3. Propriétaire : aucun rôle n'est imposé. CREATE OR REPLACE conserve le propriétaire
--     existant ; la garde ci-dessous vérifie seulement qu'il est aussi propriétaire de
--     public.profiles, sans FORCE ROW LEVEL SECURITY. C'est ce qui permet à la fonction de
--     lire profiles sans RLS récursive. Sinon la migration s'arrête sans rien modifier.
--
-- Réexécutable : garde en lecture seule, CREATE OR REPLACE, REVOKE et GRANT idempotents.
-- Tests : oralink/crm/tests/is-account-member.sql, run-is-account-member-mutations.sh.

DO $$
DECLARE
  v_fn regprocedure := to_regprocedure('public.is_account_member(uuid, public.account_role_enum)');
  v_fn_owner name;
  v_profiles_owner name;
  v_force boolean;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '903: public.is_account_member(uuid, account_role_enum) absente (017 non appliquée ?)';
  END IF;
  SELECT pg_get_userbyid(proowner) INTO v_fn_owner FROM pg_proc WHERE oid = v_fn;
  SELECT pg_get_userbyid(relowner), relforcerowsecurity INTO v_profiles_owner, v_force
    FROM pg_class WHERE oid = 'public.profiles'::regclass;
  IF v_fn_owner IS DISTINCT FROM v_profiles_owner THEN
    RAISE EXCEPTION '903: propriétaire de is_account_member (%) différent de celui de public.profiles (%) : arrêt, à examiner avant migration',
      v_fn_owner, v_profiles_owner;
  END IF;
  IF v_force THEN
    RAISE EXCEPTION '903: FORCE ROW LEVEL SECURITY actif sur public.profiles : la fonction ne pourrait plus lire profiles, arrêt';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role public.account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'::public.account_role_enum  THEN 4
            WHEN 'admin'::public.account_role_enum  THEN 3
            WHEN 'agent'::public.account_role_enum  THEN 2
            WHEN 'viewer'::public.account_role_enum THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'::public.account_role_enum  THEN 4
            WHEN 'admin'::public.account_role_enum  THEN 3
            WHEN 'agent'::public.account_role_enum  THEN 2
            WHEN 'viewer'::public.account_role_enum THEN 1
          END
  );
$$;

REVOKE ALL ON FUNCTION public.is_account_member(UUID, public.account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_account_member(UUID, public.account_role_enum)
  TO anon, authenticated, service_role;
