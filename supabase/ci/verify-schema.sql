-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
DECLARE gate_function record; settings_rpc text;
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb)'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 041 did not apply';
  END IF;

  IF to_regprocedure(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'the JSONB[] overload of create_broadcast_with_recipients still exists — migration 049 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd IN ('SELECT', 'ALL')
      AND (roles && ARRAY['public', 'anon']::name[])
      AND (qual LIKE '%avatars%' OR qual LIKE '%flow-media%' OR qual LIKE '%chat-media%')
  ) THEN
    RAISE EXCEPTION
      'a storage SELECT policy on avatars/flow-media/chat-media still applies to anon — migration 043 did not apply';
  END IF;
  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT'
      AND roles = ARRAY['authenticated']::name[]
      AND policyname IN (
        'Users can read their own avatar',
        'Members can read flow media',
        'Members can read chat media'
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'the scoped storage SELECT policies are missing — migration 043 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'public._bcast_bump(uuid,text,integer)',
      'public.recompute_broadcast_counts(uuid)',
      'public.claim_ai_reply_slot(uuid,integer)',
      'public.record_webhook_failure(uuid,integer)',
      'public.merge_duplicate_contacts()',
      'public.merge_duplicate_conversations()'
    ]::regprocedure[]) AS f(fn)
    WHERE has_function_privilege('anon', f.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', f.fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f.fn, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'an internal SECURITY DEFINER function is still executable by anon/authenticated — migration 044 did not apply';
  END IF;

  -- 045 widens the automation_pending_executions status CHECK. It is a
  -- DROP + ADD by name, so a wrong constraint name would leave the old
  -- CHECK in place and every "wait for reply" park would be rejected at
  -- runtime, not at migration time.
  IF pg_get_constraintdef(
       (SELECT oid FROM pg_constraint
        WHERE conname = 'automation_pending_executions_status_check')
     ) NOT LIKE '%awaiting_reply%' THEN
    RAISE EXCEPTION
      'automation_pending_executions_status_check does not allow awaiting_reply — migration 045 did not apply';
  END IF;
  IF to_regclass('public.idx_automation_pending_awaiting_reply') IS NULL THEN
    RAISE EXCEPTION
      'idx_automation_pending_awaiting_reply is missing — migration 045 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default LIKE '%uuid_generate_v%'
  ) THEN
    RAISE EXCEPTION
      'a public column default still calls uuid-ossp; use gen_random_uuid() so a fresh hosted db push does not hit 42883';
  END IF;

  IF to_regprocedure('public.dashboard_overview(integer,text)') IS NULL THEN
    RAISE EXCEPTION 'public.dashboard_overview(integer, text) is missing — migration 059 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'messages_track_conversation_times') THEN
    RAISE EXCEPTION 'messages_track_conversation_times trigger is missing — migration 059 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'conversations_stamp_closed_at')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'deals_stamp_closed_at') THEN
    RAISE EXCEPTION 'closed_at triggers are missing — migration 059 did not apply';
  END IF;
  IF has_function_privilege('anon', 'public.dashboard_overview(integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute dashboard_overview — migration 059 grants are wrong';
  END IF;

  -- Coexistence's private queue and old-source realtime payload are load-bearing.
  IF to_regclass('public.coexistence_jobs') IS NULL
     OR to_regclass('public.coexistence_message_metadata') IS NULL
     OR to_regclass('public.coexistence_contact_state') IS NULL
     OR to_regclass('public.coexistence_progress') IS NULL THEN
    RAISE EXCEPTION 'Coexistence service tables are missing — migration 060 did not apply';
  END IF;
  IF has_table_privilege('authenticated', 'public.coexistence_jobs', 'SELECT')
     OR has_function_privilege('authenticated', 'public.coexistence_commit(uuid,uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Coexistence ingestion is not service-only';
  END IF;
  IF NOT (SELECT relreplident = 'f' FROM pg_class WHERE oid = 'public.messages'::regclass) THEN
    RAISE EXCEPTION 'Realtime history-to-live notifications need messages replica identity FULL';
  END IF;
  IF pg_get_functiondef('public.redeem_invitation(text)'::regprocedure)
     NOT LIKE '%FROM coexistence_jobs WHERE account_id = v_old_account_id%' THEN
    RAISE EXCEPTION 'Invitation redemption must preserve queued Coexistence work — migration 061 did not apply';
  END IF;

  IF to_regclass('public.coexistence_live_effects') IS NULL THEN
    RAISE EXCEPTION 'Coexistence pending live effects are missing — migration 062 did not apply';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.coexistence_live_effects'::regclass)
     OR has_table_privilege('authenticated', 'public.coexistence_live_effects', 'SELECT')
     OR has_table_privilege('anon', 'public.coexistence_live_effects', 'SELECT') THEN
    RAISE EXCEPTION 'Coexistence pending live effects must remain service-only';
  END IF;

  IF to_regprocedure('public.coexistence_effect_claim(text,integer)') IS NULL
     OR to_regprocedure('public.coexistence_effect_begin(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.coexistence_effect_settle(uuid,uuid,integer,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Coexistence effect recovery functions are missing — migration 063 did not apply';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'public.coexistence_effect_claim(text,integer)',
      'public.coexistence_effect_begin(uuid,uuid,text)',
      'public.coexistence_effect_settle(uuid,uuid,integer,text,boolean)'
    ]::regprocedure[]) AS f(fn)
    WHERE has_function_privilege('anon', f.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', f.fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f.fn, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Coexistence effect recovery must remain service-only';
  END IF;

  IF to_regclass('public.coexistence_lifecycle_evidence') IS NULL
     OR to_regprocedure('public.coexistence_capture(text,jsonb,text)') IS NULL
     OR to_regclass('public.coexistence_jobs_delivery_receipt') IS NULL THEN
    RAISE EXCEPTION 'Coexistence lifecycle/replay fence is missing — migrations 064–065 did not apply';
  END IF;
  IF has_table_privilege('authenticated', 'public.coexistence_lifecycle_evidence', 'SELECT')
     OR has_table_privilege('anon', 'public.coexistence_lifecycle_evidence', 'SELECT')
     OR has_function_privilege('authenticated', 'public.coexistence_capture(text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.coexistence_capture(text,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.coexistence_capture(text,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Coexistence lifecycle authority must remain service-only';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('flow_runs','automation_logs','automation_pending_executions','broadcasts')
      AND column_name IN ('send_config_id','send_generation')) <> 8 THEN
    RAISE EXCEPTION 'Queued send origins are missing';
  END IF;

  IF to_regclass('public.coexistence_updates') IS NULL
     OR to_regclass('public.coexistence_reaction_order') IS NULL
     OR to_regclass('public.coexistence_status_events') IS NULL
     OR to_regprocedure('public.coexistence_recover_updates(integer)') IS NULL
     OR to_regprocedure('public.coexistence_status_event_claim(text,integer)') IS NULL
     OR to_regprocedure('public.coexistence_status_event_settle(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Coexistence status/reaction recovery is missing — migrations 066–067 did not apply';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN (
      'public.coexistence_updates'::regclass,'public.coexistence_reaction_order'::regclass,
      'public.coexistence_status_events'::regclass)
    AND (NOT relrowsecurity OR has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE'))) THEN
    RAISE EXCEPTION 'Coexistence update state must remain service-only';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[
      'public.coexistence_recover_updates(integer)',
      'public.coexistence_status_event_claim(text,integer)',
      'public.coexistence_status_event_settle(uuid,uuid,text)'
    ]::regprocedure[]) AS f(fn)
    WHERE has_function_privilege('authenticated',f.fn,'EXECUTE')
      OR has_function_privilege('anon',f.fn,'EXECUTE')
      OR NOT has_function_privilege('service_role',f.fn,'EXECUTE')) THEN
    RAISE EXCEPTION 'Coexistence update recovery RPCs must remain service-only';
  END IF;
  IF pg_get_functiondef('public.redeem_invitation(text)'::regprocedure)
      NOT LIKE '%FROM coexistence_updates WHERE account_id = v_old_account_id%'
     OR pg_get_functiondef('public.redeem_invitation(text)'::regprocedure)
      NOT LIKE '%FROM coexistence_status_events WHERE account_id = v_old_account_id%' THEN
    RAISE EXCEPTION 'Coexistence update invitation guard is missing — migration 068 did not apply';
  END IF;

  IF (SELECT relreplident FROM pg_class WHERE oid='public.message_reactions'::regclass) <> 'f' THEN
    RAISE EXCEPTION 'Reaction DELETE routing needs full replica identity — migration 069 did not apply';
  END IF;

  IF to_regprocedure('public.persist_outbound_message(uuid,uuid,uuid,uuid,jsonb,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'Atomic outbound persistence is missing — migration 070 did not apply';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND (
      (table_name='coexistence_message_metadata' AND column_name IN ('source_config_id','source_generation','outbound_created_at','outbound_preview'))
      OR (table_name='coexistence_updates' AND column_name='advanced_message_id'))) <> 5
     OR has_table_privilege('authenticated','public.coexistence_message_metadata','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon','public.coexistence_message_metadata','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Outbound provenance and transition proof must exist and remain private';
  END IF;
  IF has_function_privilege('anon', 'public.persist_outbound_message(uuid,uuid,uuid,uuid,jsonb,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.persist_outbound_message(uuid,uuid,uuid,uuid,jsonb,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.persist_outbound_message(uuid,uuid,uuid,uuid,jsonb,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Outbound persistence RPC grants are invalid';
  END IF;

  IF to_regclass('public.coexistence_private_media_ids') IS NULL
     OR to_regprocedure('public.coexistence_media_context(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.coexistence_is_private_media(text)') IS NULL
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.coexistence_message_metadata'::regclass
       AND tgname='coexistence_project_private_media' AND NOT tgisinternal AND tgenabled='O') THEN
    RAISE EXCEPTION 'Private media projection and deny proofs are missing — migration 071 did not apply';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.coexistence_private_media_ids'::regclass)
     OR has_table_privilege('anon','public.coexistence_private_media_ids','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated','public.coexistence_private_media_ids','SELECT,INSERT,UPDATE,DELETE')
     OR has_function_privilege('anon','public.coexistence_media_context(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.coexistence_media_context(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.coexistence_is_private_media(text)','EXECUTE')
     OR has_function_privilege('authenticated','public.coexistence_is_private_media(text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.coexistence_media_context(uuid,uuid,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.coexistence_is_private_media(text)','EXECUTE') THEN
    RAISE EXCEPTION 'Private media metadata and deny proofs must remain server-only';
  END IF;

  IF to_regprocedure('public.coexistence_operator_inventory(uuid,uuid,text,text,timestamptz,uuid,integer)') IS NULL
     OR to_regprocedure('public.coexistence_operator_inspect(uuid,uuid,uuid,text,uuid)') IS NULL
     OR to_regprocedure('public.coexistence_operator_requeue(uuid,uuid,uuid,text,uuid,text)') IS NULL
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
       AND table_name='coexistence_jobs' AND column_name IN ('operator_request_id','operator_requested_at',
         'operator_actor_id','operator_previous_attempts','operator_previous_error')) <> 5 THEN
    RAISE EXCEPTION 'Operator inventory and once-only recovery audit are missing — migration 072 did not apply';
  END IF;
  IF has_function_privilege('anon','public.coexistence_operator_inventory(uuid,uuid,text,text,timestamptz,uuid,integer)','EXECUTE')
     OR has_function_privilege('authenticated','public.coexistence_operator_inventory(uuid,uuid,text,text,timestamptz,uuid,integer)','EXECUTE')
     OR has_function_privilege('anon','public.coexistence_operator_inspect(uuid,uuid,uuid,text,uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.coexistence_operator_inspect(uuid,uuid,uuid,text,uuid)','EXECUTE')
     OR has_function_privilege('anon','public.coexistence_operator_requeue(uuid,uuid,uuid,text,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.coexistence_operator_requeue(uuid,uuid,uuid,text,uuid,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.coexistence_operator_inventory(uuid,uuid,text,text,timestamptz,uuid,integer)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.coexistence_operator_inspect(uuid,uuid,uuid,text,uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.coexistence_operator_requeue(uuid,uuid,uuid,text,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Operator inventory, inspection and mutation RPCs must remain service-only';
  END IF;

  IF to_regclass('public.connection_operations') IS NULL
     OR to_regclass('public.connection_operation_resources') IS NULL
     OR to_regclass('public.connection_operations_one_active_account') IS NULL
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
       AND table_name='accounts' AND column_name='connection_revision' AND is_nullable='NO' AND udt_name='uuid') THEN
    RAISE EXCEPTION 'Connection-operation authority is missing — migration 073 did not apply';
  END IF;
  IF NOT (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN
       ('public.connection_operations'::regclass,'public.connection_operation_resources'::regclass))
     OR has_table_privilege('authenticated','public.connection_operations','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon','public.connection_operations','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role','public.connection_operations','INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated','public.connection_operation_resources','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon','public.connection_operation_resources','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role','public.connection_operation_resources','INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated','public.whatsapp_config','INSERT,UPDATE,DELETE')
     OR NOT has_column_privilege('authenticated','public.whatsapp_config','mirror_inbound_media','UPDATE') THEN
    RAISE EXCEPTION 'Connection gate grants permit bypass or break media preference updates';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN
      ('connection_config_write_guard','connection_revision_write_guard','connection_account_delete_guard','connection_profile_move_guard'))<>4 THEN
    RAISE EXCEPTION 'Connection gate write/deletion/invitation guards are missing';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
      ('connection_operation_acquire','connection_operation_start_step','connection_operation_record_step',
       'connection_operation_finish','connection_operation_cancel_unstarted','connection_operation_status','connection_operation_account_status'))<>7 THEN
    RAISE EXCEPTION 'Connection gate RPCs are missing';
  END IF;
  FOR gate_function IN SELECT oid,proname,prosecdef,proconfig,pg_get_userbyid(proowner) AS owner FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND proname LIKE 'connection_operation_%' LOOP
    IF gate_function.owner<>'postgres'
       OR has_function_privilege('anon',gate_function.oid,'EXECUTE')
       OR has_function_privilege('authenticated',gate_function.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Connection gate function must be trusted and nonpublic: %',gate_function.proname;
    END IF;
    IF gate_function.proname NOT IN ('connection_operation_authorized','connection_operation_binding','connection_operation_lock','connection_operation_retire_unstarted','connection_operation_resource_id','connection_operation_finish_before_075')
       AND (NOT gate_function.prosecdef OR NOT has_function_privilege('service_role',gate_function.oid,'EXECUTE')
         OR NOT gate_function.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION 'Connection gate RPC must be service-only definer with fixed search path: %',gate_function.proname;
    END IF;
    IF gate_function.proname IN ('connection_operation_authorized','connection_operation_binding','connection_operation_lock','connection_operation_retire_unstarted','connection_operation_resource_id','connection_operation_finish_before_075')
       AND has_function_privilege('service_role',gate_function.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Connection gate helper exposed: %',gate_function.proname;
    END IF;
  END LOOP;

  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects'
      AND column_name='user_metadata' AND udt_name='jsonb')
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='storage.objects'::regclass
      AND tgname='connection_legacy_media_publication_guard' AND NOT tgisinternal AND tgenabled='O')
     OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.connection_legacy_media_publication_guard()'::regprocedure
       AND prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=public, pg_temp'])
     OR pg_get_functiondef('public.connection_legacy_media_publication_guard()'::regprocedure) NOT LIKE '%NEW.user_metadata%'
     OR has_function_privilege('anon','public.connection_legacy_media_publication_guard()','EXECUTE')
     OR has_function_privilege('authenticated','public.connection_legacy_media_publication_guard()','EXECUTE')
     OR has_function_privilege('service_role','public.connection_legacy_media_publication_guard()','EXECUTE') THEN
    RAISE EXCEPTION 'Legacy mirror publication guard must remain private and enabled';
  END IF;

  IF to_regclass('public.coexistence_signup_attempts') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.coexistence_signup_attempts'::regclass)
     OR has_table_privilege('anon','public.coexistence_signup_attempts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated','public.coexistence_signup_attempts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role','public.coexistence_signup_attempts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
       'coexistence_signup_prepare','coexistence_signup_launch','coexistence_signup_exchange_start',
       'coexistence_signup_store_token','coexistence_signup_token','coexistence_signup_verify',
       'coexistence_signup_confirm','coexistence_signup_review','coexistence_signup_status','coexistence_signup_media_allowed'))<>10
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.connection_operations'::regclass
       AND conname IN ('connection_operations_signup_kind_check','connection_operations_signup_steps_check'))<>2 THEN
    RAISE EXCEPTION 'Private supervised signup authority missing or exposed — migration 074 did not apply';
  END IF;
  FOR gate_function IN SELECT oid,proname,prosecdef,proconfig,pg_get_userbyid(proowner) AS owner FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND proname LIKE 'coexistence_signup_%' LOOP
    IF gate_function.owner<>'postgres' OR NOT coalesce(gate_function.proconfig @> ARRAY[CASE gate_function.proname
         WHEN 'coexistence_signup_invitation_issue' THEN 'search_path=pg_catalog, public, pg_temp'
         WHEN 'coexistence_signup_negative_fence' THEN 'search_path=pg_catalog, public, pg_temp'
         WHEN 'coexistence_signup_invitation_issue_immutable' THEN 'search_path=pg_catalog, pg_temp'
         ELSE 'search_path=public, pg_temp' END],false)
       OR has_function_privilege('anon',gate_function.oid,'EXECUTE')
       OR has_function_privilege('authenticated',gate_function.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Signup function must be trusted, fixed-path and private: %',gate_function.proname;
    END IF;
    IF gate_function.proname IN ('coexistence_signup_lock','coexistence_signup_owner','coexistence_signup_scrub',
      'coexistence_signup_launch_time_guard','coexistence_signup_negative_fence','coexistence_signup_fenced_lock',
      'coexistence_signup_negative_fence_before_084','coexistence_signup_invitation_issue','coexistence_signup_invitation_issue_immutable',
      'coexistence_signup_recovery_lock_actor','coexistence_signup_recovery_pristine','coexistence_signup_recovery_lock_attempt') THEN
      IF has_function_privilege('service_role',gate_function.oid,'EXECUTE') THEN
        RAISE EXCEPTION 'Signup helper exposed: %',gate_function.proname;
      END IF;
    ELSIF NOT gate_function.prosecdef OR NOT has_function_privilege('service_role',gate_function.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Signup RPC must be service-only definer: %',gate_function.proname;
    END IF;
  END LOOP;

  IF to_regprocedure('public.coexistence_signup_recovery_status(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.coexistence_signup_recovery_record(uuid,uuid,uuid,uuid,uuid,text)') IS NULL
    OR to_regclass('public.coexistence_signup_recovery_receipts') IS NULL THEN
    RAISE EXCEPTION 'Private signup recovery missing — migration 076 did not apply';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.coexistence_signup_recovery_receipts'::regclass
      AND relrowsecurity AND pg_get_userbyid(relowner)='postgres')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE has_table_privilege(r,'public.coexistence_signup_recovery_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,'public.coexistence_signup_recovery_receipts','SELECT,INSERT,UPDATE,REFERENCES'))
    OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'coexistence_signup_recovery_%'
        AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
    OR EXISTS(SELECT 1 FROM pg_proc WHERE oid IN ('public.coexistence_signup_recovery_status(uuid,uuid,uuid)'::regprocedure,
      'public.coexistence_signup_recovery_record(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure) AND prorettype<>'jsonb'::regtype) THEN
    RAISE EXCEPTION 'Signup recovery receipt or RPC contract is exposed or untrusted';
  END IF;

  IF to_regclass('public.coexistence_history_intents') IS NULL
    OR to_regprocedure('public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Private history-only intent missing — migration 077 did not apply';
  END IF;
  SELECT p.* INTO STRICT gate_function FROM pg_proc p
    WHERE p.oid='public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)'::regprocedure;
  IF NOT gate_function.prosecdef OR gate_function.prorettype<>'jsonb'::regtype
    OR pg_get_userbyid(gate_function.proowner)<>'postgres'
    OR NOT coalesce(gate_function.proconfig @> ARRAY['search_path=public, pg_temp'],false)
    OR NOT has_function_privilege('service_role',gate_function.oid,'EXECUTE')
    OR EXISTS(SELECT 1 FROM aclexplode(coalesce(gate_function.proacl,acldefault('f',gate_function.proowner)))
      WHERE grantee=0 AND privilege_type='EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.coexistence_history_intents'::regclass
      AND relrowsecurity AND pg_get_userbyid(relowner)='postgres')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE (r<>'service_role' AND has_function_privilege(r,gate_function.oid,'EXECUTE'))
        OR has_table_privilege(r,'public.coexistence_history_intents','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,'public.coexistence_history_intents','SELECT,INSERT,UPDATE,REFERENCES')) THEN
    RAISE EXCEPTION 'History intent table or RPC is exposed or untrusted';
  END IF;

  IF to_regclass('public.coexistence_receiver_vetoes') IS NULL
    OR to_regprocedure('public.coexistence_receiver_stop(text,text,text,text,text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'Private receiver veto missing — migration 078 did not apply';
  END IF;
  SELECT p.* INTO STRICT gate_function FROM pg_proc p
    WHERE p.oid='public.coexistence_receiver_stop(text,text,text,text,text,integer,integer)'::regprocedure;
  IF NOT gate_function.prosecdef OR gate_function.prorettype<>'jsonb'::regtype
    OR pg_get_userbyid(gate_function.proowner)<>'postgres'
    OR NOT coalesce(gate_function.proconfig @> ARRAY['search_path=public, pg_temp'],false)
    OR NOT has_function_privilege('service_role',gate_function.oid,'EXECUTE')
    OR EXISTS(SELECT 1 FROM aclexplode(coalesce(gate_function.proacl,acldefault('f',gate_function.proowner)))
      WHERE grantee=0 AND privilege_type='EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.coexistence_receiver_vetoes'::regclass
      AND relrowsecurity AND pg_get_userbyid(relowner)='postgres')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.whatsapp_config'::regclass
      AND tgname='receiver_veto_config_guard' AND tgenabled='O')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE (r<>'service_role' AND has_function_privilege(r,gate_function.oid,'EXECUTE'))
        OR has_table_privilege(r,'public.coexistence_receiver_vetoes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,'public.coexistence_receiver_vetoes','SELECT,INSERT,UPDATE,REFERENCES')
        OR has_function_privilege(r,'public.coexistence_history_intent_record_before_078(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)','EXECUTE')
        OR has_function_privilege(r,'public.coexistence_receiver_meta_signup_fence(uuid,text,text)','EXECUTE')) THEN
    RAISE EXCEPTION 'Receiver veto table, guard or RPC is exposed or untrusted';
  END IF;

  SELECT p.* INTO gate_function FROM pg_proc p
    WHERE p.oid=to_regprocedure('public.coexistence_import_consent(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,boolean,boolean,uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post-binding import consent RPC missing — migration 079 did not apply';
  END IF;
  IF NOT gate_function.prosecdef OR gate_function.prorettype<>'jsonb'::regtype
    OR pg_get_userbyid(gate_function.proowner)<>'postgres'
    OR NOT coalesce(gate_function.proconfig @> ARRAY['search_path=public, pg_temp'],false)
    OR NOT has_function_privilege('service_role',gate_function.oid,'EXECUTE')
    OR has_function_privilege('anon',gate_function.oid,'EXECUTE')
    OR has_function_privilege('authenticated',gate_function.oid,'EXECUTE')
    OR EXISTS(SELECT 1 FROM aclexplode(coalesce(gate_function.proacl,acldefault('f',gate_function.proowner)))
      WHERE grantee=0 AND privilege_type='EXECUTE') THEN
    RAISE EXCEPTION 'Post-binding import consent RPC is exposed or untrusted';
  END IF;
  IF to_regclass('public.coexistence_import_decisions') IS NULL
    OR to_regprocedure('public.coexistence_commit_before_079(uuid,uuid,jsonb)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.coexistence_jobs'::regclass
      AND attname='import_consent_id' AND NOT attisdropped AND atttypid='uuid'::regtype)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.coexistence_jobs'::regclass
      AND tgname='coexistence_import_stamp' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Private import decision and original job authority stamp missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.coexistence_import_decisions'::regclass
    AND relrowsecurity AND pg_get_userbyid(relowner)='postgres')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE has_table_privilege(r,'public.coexistence_import_decisions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,'public.coexistence_import_decisions','SELECT,INSERT,UPDATE,REFERENCES')
        OR has_column_privilege(r,'public.coexistence_jobs','import_consent_id','INSERT,UPDATE')
        OR (r<>'service_role' AND has_column_privilege(r,'public.coexistence_jobs','import_consent_id','SELECT'))
        OR has_function_privilege(r,'public.coexistence_commit_before_079(uuid,uuid,jsonb)','EXECUTE'))
    OR pg_get_function_result('public.coexistence_claim(integer)'::regprocedure)
      IS DISTINCT FROM 'TABLE(id uuid, payload jsonb, lease_token uuid)' THEN
    RAISE EXCEPTION 'Import decision, prior commit, or opaque job authority is exposed';
  END IF;

  FOREACH settings_rpc IN ARRAY ARRAY[
    'public.coexistence_import_settings_status(uuid,uuid,uuid,text,text,text)',
    'public.coexistence_import_settings_record(uuid,uuid,uuid,text,text,text,text,uuid,uuid,boolean,boolean,text)'
  ] LOOP
    SELECT p.* INTO gate_function FROM pg_proc p WHERE p.oid=to_regprocedure(settings_rpc);
    IF NOT FOUND OR NOT gate_function.prosecdef OR gate_function.prorettype<>'jsonb'::regtype
      OR pg_get_userbyid(gate_function.proowner)<>'postgres'
      OR NOT coalesce(gate_function.proconfig @> ARRAY['search_path=public, pg_temp'],false)
      OR NOT has_function_privilege('service_role',gate_function.oid,'EXECUTE')
      OR has_function_privilege('anon',gate_function.oid,'EXECUTE')
      OR has_function_privilege('authenticated',gate_function.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(gate_function.proacl,acldefault('f',gate_function.proowner)))
        WHERE grantee=0 AND privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'SQL080 Settings RPC missing, exposed or untrusted: %',settings_rpc;
    END IF;
  END LOOP;
  settings_rpc:='public.coexistence_import_settings_snapshot(uuid,uuid,uuid,text,text,text)';
  SELECT p.* INTO gate_function FROM pg_proc p WHERE p.oid=to_regprocedure(settings_rpc);
  IF NOT FOUND OR pg_get_userbyid(gate_function.proowner)<>'postgres'
    OR NOT coalesce(gate_function.proconfig @> ARRAY['search_path=public, pg_temp'],false)
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE has_function_privilege(r,gate_function.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'SQL080 private Settings snapshot missing or exposed';
  END IF;

  IF to_regprocedure('public.coexistence_pilot_activate(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)') IS NULL
    OR to_regprocedure('public.coexistence_pilot_history_review(uuid,uuid,uuid,uuid,text,uuid,uuid,text)') IS NULL
    OR to_regclass('public.coexistence_pilot_bindings') IS NULL
    OR NOT EXISTS(SELECT FROM pg_class WHERE oid='public.coexistence_pilot_bindings'::regclass
      AND relrowsecurity AND pg_get_userbyid(relowner)='postgres')
    OR EXISTS(SELECT FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE has_table_privilege(r,'public.coexistence_pilot_bindings','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,'public.coexistence_pilot_bindings','SELECT,INSERT,UPDATE,REFERENCES')
        OR EXISTS(SELECT FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
          AND starts_with(p.proname,'coexistence_pilot_') AND has_function_privilege(r,p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'SQL082/083 operator-only pilot handoff missing or exposed';
  END IF;

  IF to_regprocedure('public.coexistence_signup_invitation_issue(uuid,uuid,uuid,uuid,text,text,text,text,text,text)') IS NULL
    OR NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.coexistence_signup_invitation_issue(uuid,uuid,uuid,uuid,text,text,text,text,text,text)'::regprocedure
      AND NOT prosecdef AND pg_get_userbyid(proowner)='postgres')
    OR NOT EXISTS(SELECT FROM pg_class WHERE oid=to_regclass('public.coexistence_signup_invitation_issues')
      AND relrowsecurity AND pg_get_userbyid(relowner)='postgres')
    OR EXISTS(SELECT FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE has_table_privilege(r,'public.coexistence_signup_invitation_issues','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,'public.coexistence_signup_invitation_issues','SELECT,INSERT,UPDATE,REFERENCES')
        OR has_function_privilege(r,'public.coexistence_signup_invitation_issue(uuid,uuid,uuid,uuid,text,text,text,text,text,text)','EXECUTE')) THEN
    RAISE EXCEPTION 'SQL084 private operator invitation boundary missing or exposed';
  END IF;

  IF to_regclass('public.coexistence_history_reviews') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.coexistence_history_reviews'::regclass
      AND relrowsecurity AND pg_get_userbyid(relowner)='postgres')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE has_table_privilege(r,'public.coexistence_history_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(r,'public.coexistence_history_reviews','SELECT,INSERT,UPDATE,REFERENCES')
        OR has_function_privilege(r,'public.coexistence_history_request_guard()','EXECUTE')
        OR has_function_privilege(r,'public.coexistence_history_request_account(uuid,uuid,text,text,text)','EXECUTE')) THEN
    RAISE EXCEPTION 'SQL081 history reviews or private helpers missing or exposed';
  END IF;
  FOREACH settings_rpc IN ARRAY ARRAY[
    'public.coexistence_history_request_status(uuid,uuid,text,text,text)',
    'public.coexistence_history_request_start(uuid,uuid,text,text,text,text,uuid,uuid)',
    'public.coexistence_history_request_finish(uuid,text)'
  ] LOOP
    SELECT p.* INTO gate_function FROM pg_proc p WHERE p.oid=to_regprocedure(settings_rpc);
    IF NOT FOUND OR NOT gate_function.prosecdef
      OR pg_get_userbyid(gate_function.proowner)<>'postgres'
      OR NOT coalesce(gate_function.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'],false)
      OR NOT has_function_privilege('service_role',gate_function.oid,'EXECUTE')
      OR has_function_privilege('anon',gate_function.oid,'EXECUTE')
      OR has_function_privilege('authenticated',gate_function.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(gate_function.proacl,acldefault('f',gate_function.proowner)))
        WHERE grantee=0 AND privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'SQL081 history request RPC missing, exposed or untrusted: %',settings_rpc;
    END IF;
  END LOOP;

  IF to_regclass('public.coexistence_staged_receipts') IS NULL OR to_regclass('public.coexistence_negative_evidence') IS NULL
    OR to_regprocedure('public.coexistence_ingress(text,text,boolean,boolean,jsonb)') IS NULL
    OR to_regprocedure('public.coexistence_staged_maintenance(integer)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='coexistence_signup_attempts' AND column_name='launched_at') THEN
    RAISE EXCEPTION 'Staged ingress and immutable signup observation fence missing — migration 075 did not apply';
  END IF;
  IF NOT (SELECT bool_and(relrowsecurity AND pg_get_userbyid(relowner)='postgres') FROM pg_class WHERE oid IN (
    'public.coexistence_staged_receipts'::regclass,'public.coexistence_negative_evidence'::regclass))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY[
      'public.coexistence_staged_receipts','public.coexistence_negative_evidence']) t
      WHERE has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) THEN
    RAISE EXCEPTION 'Staged receipt or negative evidence tables exposed';
  END IF;
  FOR gate_function IN SELECT oid,proname,prosecdef,proconfig,pg_get_userbyid(proowner) AS owner FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND (proname LIKE 'coexistence_staged_%'
      OR proname IN ('coexistence_ingress','coexistence_capture_before_075')) LOOP
    IF gate_function.owner<>'postgres' OR NOT gate_function.proconfig @> ARRAY['search_path=public, pg_temp']
      OR has_function_privilege('anon',gate_function.oid,'EXECUTE') OR has_function_privilege('authenticated',gate_function.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Untrusted staged function: %',gate_function.proname;
    END IF;
    IF gate_function.proname IN ('coexistence_ingress','coexistence_staged_maintenance') THEN
      IF NOT gate_function.prosecdef OR NOT has_function_privilege('service_role',gate_function.oid,'EXECUTE') THEN
        RAISE EXCEPTION 'Staged RPC must be fixed-path service definer: %',gate_function.proname;
      END IF;
    ELSIF has_function_privilege('service_role',gate_function.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Staged private helper exposed: %',gate_function.proname;
    END IF;
  END LOOP;

  IF to_regprocedure('public.coexistence_staged_lifecycle_ids_valid(jsonb)') IS NULL
    OR pg_get_functiondef('public.coexistence_capture_before_075(text,jsonb,text)'::regprocedure)
      NOT LIKE '%IF NOT coexistence_staged_lifecycle_ids_valid(v) THEN%' THEN
    RAISE EXCEPTION 'The bound lifecycle engine must reject non-string nested IDs before any authority decision';
  END IF;

  FOR gate_function IN SELECT oid,proname,prosecdef,proconfig,pg_get_userbyid(proowner) AS owner FROM pg_proc
    WHERE oid IN ('public.coexistence_project_private_media()'::regprocedure,'public.coexistence_is_private_media(text)'::regprocedure) LOOP
    IF gate_function.owner<>'postgres' OR NOT gate_function.prosecdef
      OR NOT gate_function.proconfig @> ARRAY['search_path=public, pg_temp']
      OR has_function_privilege('anon',gate_function.oid,'EXECUTE') OR has_function_privilege('authenticated',gate_function.oid,'EXECUTE')
      OR (has_function_privilege('service_role',gate_function.oid,'EXECUTE') IS DISTINCT FROM (gate_function.proname='coexistence_is_private_media')) THEN
      RAISE EXCEPTION 'Private alias-aware media boundary exposed or untrusted: %',gate_function.proname;
    END IF;
  END LOOP;
  IF pg_get_functiondef('public.coexistence_project_private_media()'::regprocedure) NOT LIKE '%ltrim(OLD.media_id%'
    OR pg_get_functiondef('public.coexistence_project_private_media()'::regprocedure) NOT LIKE '%ltrim(NEW.media_id%'
    OR pg_get_functiondef('public.coexistence_is_private_media(text)'::regprocedure) NOT LIKE '%ltrim(p_media_id%' THEN
    RAISE EXCEPTION 'Canonical alias deny proofs must cover both projection writes and classification reads';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
