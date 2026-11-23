DO $$
DECLARE
  u uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); legacy uuid:=gen_random_uuid();
  s uuid:=gen_random_uuid(); vs uuid:=gen_random_uuid(); ms uuid:=gen_random_uuid(); ls uuid:=gen_random_uuid();
  a uuid; b uuid; l uuid; la uuid; nonce_hash text; result jsonb;
  x jsonb; y jsonb; p jsonb; q jsonb; target jsonb:='{"waba_id":"210","phone_number_id":"310"}';
  pins CONSTANT jsonb:='{"app_id":"111","login_config_id":"112","partner_id":"113"}';
  proof jsonb:=jsonb_build_object('token_expires_at',to_char(timezone('UTC',now()+interval '1 hour'),'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'access_token',repeat('a',24)||':00:'||repeat('b',32));
  ra text:='coexistence_member_signup(uuid,uuid,uuid,text,jsonb)';
BEGIN
  ASSERT has_function_privilege('service_role',ra,'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated',ra,'EXECUTE');
  ASSERT NOT has_function_privilege('anon',ra,'EXECUTE');
  ASSERT NOT has_table_privilege('service_role','coexistence_signup_spent_codes','INSERT');
  ASSERT NOT has_table_privilege('service_role','coexistence_member_signup_attempts','SELECT');
  INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    SELECT id,id||'@member.invalid',now(),'{}' FROM unnest(ARRAY[u,v,m,legacy]) id;
  INSERT INTO auth.sessions(id,user_id) VALUES(s,u),(vs,v),(ms,m),(ls,legacy);
  SELECT account_id INTO STRICT a FROM profiles WHERE user_id=u;
  SELECT account_id INTO STRICT b FROM profiles WHERE user_id=v;
  SELECT account_id INTO STRICT l FROM profiles WHERE user_id=legacy;
  UPDATE profiles SET account_id=a,account_role='viewer' WHERE user_id=m;

  result:=coexistence_signup_discovery_issue(legacy,ls,l,(SELECT connection_revision FROM accounts WHERE id=l),
    '111','112','+15550100003','private-owner-discovery-v1');
  ASSERT result->>'status'='issued',result::text;
  la:=(result#>>'{invitation,attemptId}')::uuid;
  nonce_hash:=encode(sha256(convert_to(result#>>'{invitation,nonce}','UTF8')),'hex');
  ASSERT coexistence_signup_launch(legacy,l,ls,la,nonce_hash)->>'status'='started';

  SET LOCAL ROLE service_role;
  ASSERT coexistence_member_signup(u,vs,a,'inspect','{}')->>'status'='forbidden';
  ASSERT coexistence_member_signup(u,s,b,'inspect','{}')->>'status'='forbidden';
  ASSERT coexistence_member_signup(m,ms,a,'inspect','{}')->>'status'='available';
  ASSERT coexistence_member_signup(v,vs,b,'inspect','{}')->>'status'='available';
  x:=coexistence_member_signup(m,ms,a,'launch',pins||'{"intended_phone":"+15550100001"}');
  y:=coexistence_member_signup(v,vs,b,'launch',pins||'{"intended_phone":"+15550100002"}');
  ASSERT x->>'status'='launch_authorized',x::text;
  ASSERT y->>'status'='launch_authorized',y::text;
  p:=pins||jsonb_build_object('state',x->>'state');
  q:=pins||jsonb_build_object('state',y->>'state');
  ASSERT coexistence_member_signup(u,s,a,'exchange_authorized',p)->>'status'='forbidden';
  ASSERT coexistence_member_signup(v,vs,b,'exchange_authorized',p)->>'status'='forbidden';
  ASSERT coexistence_member_signup(m,ms,a,'exchange_start',p||jsonb_build_object('code_hash',repeat('b',64))) @> '{"status":"started","dispatch":true}';
  ASSERT coexistence_signup_exchange_start(legacy,l,ls,la,nonce_hash,repeat('b',64))->>'status'='conflict';
  ASSERT coexistence_signup_exchange_start(legacy,l,ls,la,nonce_hash,repeat('a',64))->>'status'='started';
  ASSERT coexistence_member_signup(v,vs,b,'exchange_start',q||jsonb_build_object('code_hash',repeat('a',64)))->>'status'='conflict';
  ASSERT coexistence_member_signup(v,vs,b,'exchange_start',q||jsonb_build_object('code_hash',repeat('b',64)))->>'status'='conflict';
  ASSERT coexistence_member_signup(v,vs,b,'exchange_start',q||jsonb_build_object('code_hash',repeat('c',64))) @> '{"status":"started","dispatch":true}';
  ASSERT coexistence_member_signup(v,vs,b,'exchange_start',q||jsonb_build_object('code_hash',repeat('d',64)))->>'status'='duplicate';
  ASSERT coexistence_member_signup(m,ms,a,'exchange_authorized',p||'{"partner_id":"114"}')->>'status'='conflict';
  ASSERT coexistence_member_signup(m,ms,a,'exchange_authorized',p)->>'status'='authorized';
  RESET ROLE;

  -- Independent revocations invalidate prior callback authorization immediately.
  UPDATE auth.sessions SET not_after=now()-interval '1 second' WHERE id=ms;
  ASSERT coexistence_member_signup(m,ms,a,'exchange_authorized',p)->>'status'='forbidden';
  UPDATE auth.sessions SET not_after=NULL WHERE id=ms;
  BEGIN
    UPDATE profiles SET account_id=l, account_role='agent' WHERE user_id=m;
    ASSERT coexistence_member_signup(m,ms,a,'exchange_authorized',p)->>'status'='forbidden';
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  UPDATE profiles SET account_role='agent' WHERE user_id=m;
  UPDATE auth.users SET email_confirmed_at=NULL WHERE id=m;
  ASSERT coexistence_member_signup(m,ms,a,'exchange_authorized',p)->>'status'='forbidden';
  UPDATE auth.users SET email_confirmed_at=now() WHERE id=m;

  SET LOCAL ROLE service_role;
  ASSERT coexistence_member_signup(m,ms,a,'confirm',p||target)->>'status'='conflict';
  ASSERT coexistence_member_signup(m,ms,a,'verify',p||target||proof||'{"normalized_phone_number":"+15550100002"}')->>'status'='conflict';
  ASSERT coexistence_member_signup(m,ms,a,'verify',p||target||proof||'{"normalized_phone_number":"+15550100001"}')->>'status'='verified';
  ASSERT coexistence_member_signup(m,ms,a,'confirm',p||target||'{"phone_number_id":"311"}')->>'status'='conflict';
  ASSERT coexistence_member_signup(m,ms,a,'confirm',p||target)->>'status'='confirmed';
  ASSERT coexistence_member_signup(u,s,a,'inspect','{}')->>'status'='pending';
  ASSERT coexistence_member_signup(v,vs,b,'verify',q||target||proof||'{"normalized_phone_number":"+15550100002"}')->>'status'='conflict';
  target:='{"waba_id":"220","phone_number_id":"320"}';
  ASSERT coexistence_member_signup(v,vs,b,'verify',q||target||proof||'{"normalized_phone_number":"+15550100002"}')->>'status'='verified';
  BEGIN
    ASSERT coexistence_receiver_stop('111','220','320','ACCOUNT_OFFBOARDED',repeat('e',64),0,0)->>'status'='blocked';
    ASSERT coexistence_member_signup(v,vs,b,'confirm',q||target)->>'status'='blocked';
    RAISE SQLSTATE 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
  END;
  ASSERT coexistence_member_signup(v,vs,b,'confirm',q||target)->>'status'='confirmed';
  ASSERT coexistence_member_signup(v,vs,b,'inspect','{}')->>'status'='pending';
  RESET ROLE;
  ASSERT NOT EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id IN (a,b));
  ASSERT NOT EXISTS(SELECT 1 FROM coexistence_pilot_bindings WHERE account_id IN (a,b));
  ASSERT (SELECT count(*) FROM connection_operation_resources r JOIN connection_operations o ON o.id=r.operation_id WHERE o.account_id=a)=2;
END $$;
