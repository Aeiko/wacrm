-- Staff staging only, after SQL084. Do not install this on KC for the rehearsal.
-- Unlike signup_status, this read neither scrubs tokens nor records new lifecycle evidence.
BEGIN;
CREATE FUNCTION public.coexistence_inspect_staff_invite(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_connection_revision uuid,p_app_id text,p_login_config_id text,p_waba_id text,
  p_phone_number_id text,p_intended_phone text,p_intent_id uuid,p_nonce_hash text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce((SELECT jsonb_build_object('status','ok','attempt',jsonb_build_object('id',t.id,
      'state','prepared','intended_phone',t.intended_phone,'lease_until',o.lease_until))
    FROM public.coexistence_signup_invitation_issues i JOIN public.coexistence_signup_attempts t ON t.id=i.attempt_id
    JOIN public.connection_operations o ON o.id=t.operation_id JOIN public.accounts a ON a.id=i.account_id
    WHERE ROW(i.actor_id,i.account_id,i.session_id,i.attempt_id,i.connection_revision,i.app_id,i.login_config_id,
        i.waba_id,i.phone_number_id,i.intended_phone,i.intent_id) = ROW(p_actor_id,p_account_id,p_session_id,p_attempt_id,
        p_connection_revision,p_app_id,p_login_config_id,p_waba_id,p_phone_number_id,p_intended_phone,p_intent_id)
      AND a.owner_user_id=i.actor_id AND a.connection_revision=i.connection_revision
      AND public.coexistence_signup_owner(i.actor_id,i.account_id,i.session_id)
      AND ROW(o.actor_id,o.account_id,o.original_account_id,o.expected_revision,t.session_id,t.app_id,t.login_config_id,t.intended_phone)
        = ROW(i.actor_id,i.account_id,i.account_id,i.connection_revision,i.session_id,i.app_id,i.login_config_id,i.intended_phone)
      AND t.nonce_hash=p_nonce_hash AND t.launched_at IS NULL AND t.reason IS NULL AND t.code_hash IS NULL
      AND o.kind='onboarding' AND o.state='reserved' AND o.steps='{}'::jsonb AND o.lease_until>statement_timestamp()
      AND o.expected_config_id IS NULL AND o.expected_generation IS NULL
      AND NOT EXISTS(SELECT FROM public.whatsapp_config c WHERE c.account_id=i.account_id
        OR public.connection_operation_resource_id(c.waba_id)=i.waba_id OR public.connection_operation_resource_id(c.phone_number_id)=i.phone_number_id)
      AND NOT EXISTS(SELECT FROM public.coexistence_receiver_vetoes v WHERE v.app_id=i.app_id AND v.waba_id=i.waba_id)
      AND NOT EXISTS(SELECT FROM public.coexistence_negative_evidence e WHERE e.app_id=i.app_id AND e.waba_id=i.waba_id)
      AND NOT EXISTS(SELECT FROM public.connection_operation_resources r WHERE r.resource_key=ANY(ARRAY['waba:'||i.waba_id,'phone:'||i.phone_number_id]))
      AND NOT EXISTS(SELECT FROM public.connection_operations x WHERE x.id<>o.id AND x.state IN ('reserved','active','blocked','completed')
        AND (x.resource_keys && ARRAY['waba:'||i.waba_id,'phone:'||i.phone_number_id] OR x.waba_id=i.waba_id OR x.phone_number_id=i.phone_number_id))
      AND NOT EXISTS(SELECT FROM public.coexistence_pilot_bindings b WHERE b.account_id=i.account_id OR b.waba_id=i.waba_id OR b.phone_number_id=i.phone_number_id)),
    '{"status":"denied"}'::jsonb);
$$;
ALTER FUNCTION public.coexistence_inspect_staff_invite(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_inspect_staff_invite(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_inspect_staff_invite(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,text) TO service_role;
COMMIT;
