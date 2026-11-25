-- Checks for migration 021 (08_TEST_PLAN.md: "submit_inquiry refuses to change client_id,
-- meeting_id or a converted lead"). Run in the Supabase SQL Editor after the migration.
-- Everything runs inside a transaction and is rolled back, so no test data is left behind.
-- Each check raises an exception on failure; "All 021 checks passed" means success.

begin;

do $$
declare
  s uuid := gen_random_uuid();
  r inquiry_leads%rowtype;
  j jsonb;
begin
  -- 1. First call creates the row and stores fields.
  perform submit_inquiry(s, '{"name":"Test Lead","stage":"qualifying","score":3}', '[{"role":"user","content":"hi"}]');
  select * into r from inquiry_leads where session_id = s;
  if r.name is distinct from 'Test Lead' or r.stage <> 'qualifying' then
    raise exception 'FAIL 1: insert/update did not store fields';
  end if;

  -- 2. A null/missing field never erases a stored value.
  perform submit_inquiry(s, '{"stage":"qualifying"}', null);
  select * into r from inquiry_leads where session_id = s;
  if r.name is distinct from 'Test Lead' then raise exception 'FAIL 2: missing field erased name'; end if;

  -- 3. client_id and meeting_id in p_fields are ignored.
  perform submit_inquiry(s, '{"client_id":"1","meeting_id":"1","stage":"qualifying"}', null);
  select * into r from inquiry_leads where session_id = s;
  if r.client_id is not null or r.meeting_id is not null then
    raise exception 'FAIL 3: submit_inquiry wrote client_id/meeting_id';
  end if;

  -- 4. The public can't set stage to converted or closed.
  perform submit_inquiry(s, '{"stage":"converted","name":"Changed"}', null);
  select * into r from inquiry_leads where session_id = s;
  if r.stage = 'converted' or r.name = 'Changed' then raise exception 'FAIL 4: public set stage converted'; end if;

  -- 5. A converted lead (set by HQ) can't be changed through submit_inquiry.
  update inquiry_leads set stage = 'converted' where session_id = s;
  perform submit_inquiry(s, '{"stage":"handoff","name":"Changed"}', '[]');
  select * into r from inquiry_leads where session_id = s;
  if r.stage <> 'converted' or r.name <> 'Test Lead' or jsonb_array_length(r.messages) = 0 then
    raise exception 'FAIL 5: converted lead was modified';
  end if;

  -- 6. consent_at and alerted_at are set once and never overwritten.
  s := gen_random_uuid();
  perform submit_inquiry(s, '{"stage":"browsing","alerted_at":"2026-01-01T00:00:00Z"}', '[]');
  perform submit_inquiry(s, '{"stage":"browsing","alerted_at":"2026-02-02T00:00:00Z"}', '[]');
  select * into r from inquiry_leads where session_id = s;
  if r.alerted_at <> '2026-01-01T00:00:00Z'::timestamptz then raise exception 'FAIL 6: alerted_at overwritten'; end if;

  -- 7. get_inquiry_session returns chat state but no internal columns.
  j := get_inquiry_session(s);
  if j is null or j ? 'ip_hash' or j ? 'client_id' then raise exception 'FAIL 7: get_inquiry_session shape'; end if;
  if get_inquiry_session(gen_random_uuid()) is not null then raise exception 'FAIL 7b: unknown session returned data'; end if;

  -- 8. Rate limit allows p_limit hits per hour, then refuses.
  for i in 1..3 loop
    if not check_inquiry_rate_limit('test-ip-021', 3) then raise exception 'FAIL 8: refused under limit'; end if;
  end loop;
  if check_inquiry_rate_limit('test-ip-021', 3) then raise exception 'FAIL 8b: allowed over limit'; end if;

  raise notice 'All 021 checks passed';
end $$;

rollback;

-- Manual check (08_TEST_PLAN.md, environment checks): as a logged-out user and as an intern,
-- `select * from inquiry_leads` must return no rows; as an HQ admin it returns the rows.
