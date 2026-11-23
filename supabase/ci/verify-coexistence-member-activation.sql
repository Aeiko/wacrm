DO $$
DECLARE
  owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); stranger_id uuid:=gen_random_uuid();
  s uuid:=gen_random_uuid(); s2 uuid:=gen_random_uuid(); os uuid:=gen_random_uuid(); ss uuid:=gen_random_uuid();
  a uuid; b uuid; op uuid; cfg whatsapp_config%ROWTYPE; old_rev uuid; r jsonb;
  p jsonb:='{"app_id":"611","login_config_id":"612","partner_id":"613","waba_id":"620","phone_number_id":"630"}';
  number CONSTANT jsonb:='{"normalized_phone_number":"+15550174001"}';
  cipher CONSTANT text:=repeat('a',24)||':aa:'||repeat('b',32);
  proof jsonb:=jsonb_build_object('access_token',cipher,'token_expires_at',to_char(timezone('UTC',now()+interval '1 hour'),'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
BEGIN
  INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    SELECT id,id||'@activation.invalid',now(),'{}' FROM unnest(ARRAY[owner_id,member_id,stranger_id]) id;
  INSERT INTO auth.sessions(id,user_id) VALUES(s,member_id),(s2,member_id),(os,owner_id),(ss,stranger_id);
  SELECT account_id INTO STRICT a FROM profiles WHERE user_id=owner_id;
  SELECT account_id INTO STRICT b FROM profiles WHERE user_id=stranger_id;
  UPDATE profiles SET account_id=a,account_role='viewer' WHERE user_id=member_id;

  SET LOCAL ROLE service_role;
  r:=coexistence_member_signup(member_id,s,a,'launch',(p-ARRAY['waba_id','phone_number_id'])||'{"intended_phone":"+15550174001"}');
  ASSERT r->>'status'='launch_authorized';
  p:=p||jsonb_build_object('state',r->>'state');
  ASSERT coexistence_member_signup(member_id,s,a,'exchange_start',(p-ARRAY['waba_id','phone_number_id'])||jsonb_build_object('code_hash',repeat('6',64)))->>'status'='started';
  ASSERT coexistence_member_signup(member_id,s,a,'verify',p||proof||number)='{"status":"verified"}';
  ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p)='{"status":"conflict"}';
  ASSERT coexistence_member_signup(member_id,s,a,'confirm',p)='{"status":"confirmed"}';
  ASSERT coexistence_member_signup(member_id,s,a,'inspect','{}')='{"status":"pending"}';
  RESET ROLE;
  ASSERT NOT EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id=a);
  ASSERT NOT has_table_privilege('service_role','coexistence_member_signup_attempts','SELECT');
  ASSERT NOT has_function_privilege('service_role','coexistence_staged_maintenance_before_092(integer)','EXECUTE');
  SELECT connection_revision INTO old_rev FROM accounts WHERE id=a;
  SELECT id INTO STRICT op FROM connection_operations WHERE original_account_id=a AND request_id=(p->>'state')::uuid;

  SET LOCAL ROLE service_role;
  ASSERT coexistence_member_signup(owner_id,os,a,'activation_read',p)='{"status":"forbidden"}';
  ASSERT coexistence_member_signup(stranger_id,ss,b,'activate',p||number)='{"status":"forbidden"}';
  ASSERT coexistence_member_signup(member_id,s2,a,'activation_read',p)='{"status":"forbidden"}';
  ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p||'{"app_id":"616"}')='{"status":"conflict"}';
  ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p||'{"phone_number_id":"631"}')='{"status":"conflict"}';
  ASSERT coexistence_member_signup(member_id,s,a,'activate',p||'{"normalized_phone_number":"+15550174002"}')='{"status":"conflict"}';
  ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number||proof)='{"status":"invalid"}';
  ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p) @> (number||jsonb_build_object('status','activation_ready','access_token',cipher));
  RESET ROLE;

  BEGIN
    UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id=s;
    ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number)='{"status":"forbidden"}';
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  BEGIN
    UPDATE coexistence_member_signup_attempts SET expires_at=clock_timestamp() WHERE account_id=a;
    ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p)='{"status":"expired"}';
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  BEGIN
    UPDATE coexistence_member_signup_attempts SET token_expires_at=clock_timestamp() WHERE account_id=a;
    ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p)='{"status":"expired"}';
    ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number)='{"status":"expired"}';
    SET LOCAL ROLE service_role;
    ASSERT coexistence_staged_maintenance(100) @> '{"member_signup_tokens_scrubbed":1}';
    RESET ROLE;
    ASSERT EXISTS(SELECT 1 FROM coexistence_member_signup_attempts WHERE account_id=a AND confirmed_at IS NOT NULL AND access_token IS NULL);
    ASSERT (SELECT count(*) FROM connection_operation_resources WHERE operation_id=op)=2;
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  BEGIN
    ASSERT coexistence_member_signup(member_id,s2,a,'activation_abort',p)='{"status":"forbidden"}';
    ASSERT coexistence_member_signup(member_id,s,a,'activation_abort',p)='{"status":"activation_aborted"}';
    ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p)='{"status":"expired"}';
    ASSERT EXISTS(SELECT 1 FROM coexistence_member_signup_attempts WHERE account_id=a AND confirmed_at IS NOT NULL AND access_token IS NULL);
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  BEGIN
    DELETE FROM connection_operation_resources WHERE operation_id=op AND resource_key='phone:630';
    ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number)='{"status":"conflict"}';
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  BEGIN
    INSERT INTO coexistence_negative_evidence(app_id,waba_id,dedupe_key,kind)
      VALUES('611','620','synthetic-negative','PARTNER_REMOVED');
    ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number)='{"status":"blocked"}';
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  BEGIN
    ASSERT coexistence_receiver_stop('611','620','630','ACCOUNT_OFFBOARDED',repeat('f',64),0,0)='{"status":"blocked"}';
    ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p)='{"status":"blocked"}';
    ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number)='{"status":"blocked"}';
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  ASSERT NOT EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id=a);

  SET LOCAL ROLE service_role;
  ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number)='{"status":"activated"}';
  ASSERT coexistence_member_signup(owner_id,os,a,'inspect','{}')='{"status":"linked"}';
  RESET ROLE;
  SELECT * INTO STRICT cfg FROM whatsapp_config WHERE account_id=a;
  ASSERT cfg.user_id=member_id AND cfg.waba_id='620' AND cfg.phone_number_id='630' AND cfg.access_token=cipher;
  ASSERT cfg.status='connected' AND cfg.coexistence_app_id='611' AND cfg.coexistence_verified_at IS NOT NULL
    AND cfg.coexistence_generation IS NOT NULL AND cfg.subscribed_apps_at IS NOT NULL;
  ASSERT (SELECT connection_revision FROM accounts WHERE id=a)<>old_rev;
  ASSERT EXISTS(SELECT 1 FROM coexistence_member_signup_attempts WHERE account_id=a AND access_token IS NULL);
  ASSERT NOT EXISTS(SELECT 1 FROM connection_operation_resources WHERE operation_id=op);
  ASSERT EXISTS(SELECT 1 FROM connection_operations WHERE id=op AND state='completed' AND steps='{}' AND result->>'status'='activated');
  ASSERT NOT EXISTS(SELECT 1 FROM coexistence_pilot_bindings);
  ASSERT NOT EXISTS(SELECT 1 FROM coexistence_history_intents);
  ASSERT NOT EXISTS(SELECT 1 FROM coexistence_history_reviews);
  ASSERT NOT EXISTS(SELECT 1 FROM coexistence_import_decisions);
  ASSERT NOT EXISTS(SELECT 1 FROM coexistence_jobs);

  SELECT connection_revision INTO old_rev FROM accounts WHERE id=a;
  ASSERT coexistence_member_signup(member_id,s,a,'activation_read',p)='{"status":"activated"}';
  ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number)='{"status":"activated"}';
  ASSERT (SELECT connection_revision FROM accounts WHERE id=a)=old_rev;
  ASSERT coexistence_receiver_stop('611','620','630','ACCOUNT_OFFBOARDED',repeat('f',64),0,0)='{"status":"blocked"}';
  ASSERT coexistence_member_signup(member_id,s,a,'activate',p||number)='{"status":"blocked"}';
  ASSERT EXISTS(SELECT 1 FROM whatsapp_config WHERE id=cfg.id AND status='disconnected'
    AND coexistence_generation<>cfg.coexistence_generation AND coexistence_verified_at IS NULL);
END $$;
