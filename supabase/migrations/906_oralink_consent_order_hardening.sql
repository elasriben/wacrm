-- Additive correction after 904. 905 is reserved for the independent CSV export.
-- Historical seq remains audit data. decision_order is the server-owned order.
-- At transition, a revocation visible under EITHER legacy ordering is retained:
-- ambiguous history is never interpreted as permission to send. A subsequent
-- explicit START may grant again. All later decisions follow insertion order,
-- not provider time or transaction COMMIT order (same contract as 904).
--
-- One DO statement makes the migration atomic even in psql autocommit. Writers
-- are blocked throughout backfill/publication. Sequence RESTART is transactional;
-- setval is deliberately not used. Replays must not redo the historical backfill.
DO $migration$
DECLARE
  v_table_owner oid;
  v_guard_owner oid;
  v_old_sequence regclass;
  v_new_sequence regclass;
  v_first boolean;
  v_last bigint;
  v_called boolean;
  v_max bigint;
  v_sequence_max bigint;
  v_count bigint;
  v_attnum smallint;
  v_role text;
BEGIN
  LOCK TABLE public.contact_consents IN ACCESS EXCLUSIVE MODE;
  SELECT relowner INTO v_table_owner FROM pg_class
    WHERE oid = 'public.contact_consents'::regclass;
  SELECT proowner INTO v_guard_owner FROM pg_proc
    WHERE oid = 'public.oralink_consent_guard()'::regprocedure;
  IF v_table_owner IS DISTINCT FROM v_guard_owner THEN
    RAISE EXCEPTION '906: consent table and guard must have the same owner'
      USING ERRCODE = '55000';
  END IF;
  v_old_sequence := pg_get_serial_sequence('public.contact_consents', 'seq')::regclass;
  IF v_old_sequence IS NULL THEN
    RAISE EXCEPTION '906: consent identity sequence missing' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_sequence
      WHERE seqrelid = v_old_sequence AND seqincrement = 1 AND NOT seqcycle) THEN
    RAISE EXCEPTION '906: unexpected consent identity sequence configuration'
      USING ERRCODE = '55000';
  END IF;
  v_first := NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.contact_consents'::regclass
      AND attname = 'decision_order' AND NOT attisdropped);
  v_new_sequence := to_regclass('public.contact_consents_decision_order_seq');
  IF v_first AND v_new_sequence IS NOT NULL THEN
    RAISE EXCEPTION '906: reserved decision sequence already exists'
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_first AND (v_new_sequence IS NULL OR
      col_description('public.contact_consents'::regclass,
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.contact_consents'::regclass
          AND attname = 'decision_order' AND NOT attisdropped))
        IS DISTINCT FROM '906: server-owned consent decision order') THEN
    RAISE EXCEPTION '906: incompatible decision_order column or sequence'
      USING ERRCODE = '55000';
  END IF;

  IF v_first THEN
    -- Abort safely if the identity has no room for another ordinary insertion
    -- (the identity default and the guard each consume a value, as in 904).
    EXECUTE format('SELECT last_value FROM %s', v_old_sequence) INTO v_last;
    SELECT COALESCE(max(seq), 0) INTO v_max FROM public.contact_consents;
    SELECT seqmax INTO v_sequence_max FROM pg_sequence WHERE seqrelid = v_old_sequence;
    v_max := greatest(v_max, v_last, 0);
    IF v_max > v_sequence_max - 2 THEN
      RAISE EXCEPTION '906: identity sequence exhausted; manual repair required'
        USING ERRCODE = '54000';
    END IF;

    ALTER TABLE public.contact_consents ADD COLUMN decision_order bigint;
    COMMENT ON COLUMN public.contact_consents.decision_order
      IS '906: server-owned consent decision order';
    CREATE SEQUENCE public.contact_consents_decision_order_seq AS bigint NO CYCLE;
    EXECUTE format('ALTER SEQUENCE public.contact_consents_decision_order_seq OWNER TO %I',
      pg_get_userbyid(v_table_owner));
    ALTER SEQUENCE public.contact_consents_decision_order_seq
      OWNED BY public.contact_consents.decision_order;
    v_new_sequence := 'public.contact_consents_decision_order_seq'::regclass;

    -- Only the new technical column is populated. All recorded events, original
    -- seq, evidence, dates and identities stay unchanged. The exclusive lock and
    -- atomic statement prevent access while this single trigger is disabled.
    ALTER TABLE public.contact_consents DISABLE TRIGGER oralink_consent_guard;
    WITH timestamp_winner AS (
      SELECT DISTINCT ON (account_id, contact_id, channel, purpose)
        account_id, contact_id, channel, purpose, id, status
      FROM public.contact_consents
      ORDER BY account_id, contact_id, channel, purpose, recorded_at DESC, seq DESC, id DESC
    ), sequence_winner AS (
      SELECT DISTINCT ON (account_id, contact_id, channel, purpose)
        account_id, contact_id, channel, purpose, id, status
      FROM public.contact_consents
      ORDER BY account_id, contact_id, channel, purpose, seq DESC, id DESC
    ), preferred AS (
      SELECT t.account_id, t.contact_id, t.channel, t.purpose,
        CASE WHEN t.status = 'revoked' THEN t.id
             WHEN s.status = 'revoked' THEN s.id ELSE t.id END AS id
      FROM timestamp_winner t JOIN sequence_winner s
        USING (account_id, contact_id, channel, purpose)
    ), ranked AS (
      SELECT c.id, row_number() OVER (
        ORDER BY (c.id = p.id), c.recorded_at, c.seq, c.id) AS n
      FROM public.contact_consents c JOIN preferred p
        USING (account_id, contact_id, channel, purpose)
    )
    UPDATE public.contact_consents c SET decision_order = r.n
      FROM ranked r WHERE r.id = c.id;
    ALTER TABLE public.contact_consents ENABLE TRIGGER oralink_consent_guard;
    ALTER TABLE public.contact_consents ALTER COLUMN decision_order SET NOT NULL;

    SELECT count(*) INTO v_count FROM public.contact_consents;
    IF v_count = 9223372036854775807 THEN
      RAISE EXCEPTION '906: decision sequence exhausted' USING ERRCODE = '54000';
    END IF;
    EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', v_new_sequence, v_count + 1);
    EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', v_old_sequence, v_max + 1);
  END IF;

  -- A replay must not accept an administrator-modified generator. A descending
  -- or cached sequence could make a later STOP sort before an earlier grant.
  -- The ownership dependency also guarantees contact deletion/schema cleanup
  -- cannot leave a different, unrelated generator behind this reserved name.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_attribute a ON a.attrelid = 'public.contact_consents'::regclass
      AND a.attname = 'decision_order' AND NOT a.attisdropped
    JOIN pg_depend d ON d.classid = 'pg_class'::regclass
      AND d.objid = s.seqrelid AND d.objsubid = 0
      AND d.refclassid = 'pg_class'::regclass
      AND d.refobjid = a.attrelid AND d.refobjsubid = a.attnum
      AND d.deptype = 'a'
    WHERE s.seqrelid = v_new_sequence AND c.relkind = 'S'
      AND c.relowner = v_table_owner AND a.atttypid = 'bigint'::regtype
      AND s.seqtypid = 'bigint'::regtype AND s.seqincrement = 1
      AND NOT s.seqcycle AND s.seqcache = 1 AND s.seqmin = 1
      AND s.seqmax = 9223372036854775807
  ) THEN
    RAISE EXCEPTION '906: incompatible decision sequence owner, dependency or configuration'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format('SELECT last_value, is_called FROM %s', v_new_sequence)
    INTO v_last, v_called;
  SELECT COALESCE(max(decision_order), 0) INTO v_max FROM public.contact_consents;
  IF v_last < v_max OR (v_last = v_max AND NOT v_called) THEN
    RAISE EXCEPTION '906: decision sequence is behind recorded history; manual repair required'
      USING ERRCODE = '55000';
  END IF;

  -- Clear default grants (including those inherited from bootstrap defaults).
  -- The identity default needs USAGE before the SECURITY DEFINER guard fires.
  -- The new order has no caller-evaluated default, so it needs no runtime grant.
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role', v_old_sequence);
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO authenticated, service_role', v_old_sequence);
  REVOKE ALL ON SEQUENCE public.contact_consents_decision_order_seq
    FROM PUBLIC, anon, authenticated, service_role;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_sequence_privilege(v_role, v_old_sequence, 'UPDATE')
       OR has_sequence_privilege(v_role, v_new_sequence, 'UPDATE') THEN
      RAISE EXCEPTION '906: inherited sequence UPDATE privilege for %; review role grants', v_role
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT has_sequence_privilege(pg_get_userbyid(v_guard_owner), v_new_sequence, 'USAGE') THEN
    RAISE EXCEPTION '906: consent guard cannot allocate decision order'
      USING ERRCODE = '42501';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS contact_consents_decision_order_key
    ON public.contact_consents(decision_order);
  SELECT attnum INTO v_attnum FROM pg_attribute
    WHERE attrelid = 'public.contact_consents'::regclass
      AND attname = 'decision_order' AND NOT attisdropped AND attnotnull;
  IF v_attnum IS NULL OR EXISTS (SELECT 1 FROM public.contact_consents WHERE decision_order IS NULL)
     OR NOT EXISTS (SELECT 1 FROM pg_index
       WHERE indexrelid = 'public.contact_consents_decision_order_key'::regclass
         AND indrelid = 'public.contact_consents'::regclass
         AND indisunique AND indisvalid AND indnkeyatts = 1
         AND indkey[0] = v_attnum AND indpred IS NULL) THEN
    RAISE EXCEPTION '906: incompatible decision order column/index' USING ERRCODE = '55000';
  END IF;
  CREATE INDEX IF NOT EXISTS idx_contact_consents_latest_decision
    ON public.contact_consents(account_id, contact_id, channel, purpose, decision_order DESC);

  EXECUTE $definition$
    CREATE OR REPLACE FUNCTION public.oralink_consent_guard()
    RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.recorded_by IS NOT NULL AND NEW.recorded_by IS NULL
           AND (to_jsonb(NEW) - 'recorded_by') = (to_jsonb(OLD) - 'recorded_by') THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'contact_consents is append-only' USING ERRCODE = '42501';
      END IF;
      NEW.seq := nextval(pg_get_serial_sequence('public.contact_consents', 'seq')::regclass);
      NEW.decision_order := nextval('public.contact_consents_decision_order_seq'::regclass);
      NEW.recorded_at := clock_timestamp();
      IF NOT EXISTS (SELECT 1 FROM public.contacts c
          WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id) THEN
        RAISE EXCEPTION 'contact does not belong to account' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $definition$;
  REVOKE ALL ON FUNCTION public.oralink_consent_guard() FROM PUBLIC, anon, authenticated;

  EXECUTE $view$
    CREATE OR REPLACE VIEW public.contact_consent_current
    WITH (security_invoker = true) AS
    SELECT DISTINCT ON (account_id, contact_id, channel, purpose)
      account_id, contact_id, channel, purpose, status, source, evidence,
      recorded_at, recorded_by, id AS consent_id
    FROM public.contact_consents
    ORDER BY account_id, contact_id, channel, purpose, decision_order DESC
  $view$;
END;
$migration$;
