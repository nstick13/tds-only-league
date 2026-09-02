-- ============================================================================
-- Repair tdsonly-* cron jobs that were scheduled with the literal
-- <PROJECT_REF> / <SERVICE_ROLE_KEY> placeholders still in them.
--
-- EDIT ONE LINE: paste your service_role key into v_key below.
-- (Studio -> Project Settings -> API -> service_role, "secret")
-- The project ref is already filled in; it's public, it's in your URL.
--
-- Safe to re-run. Only rewrites jobs that still contain a placeholder.
-- ============================================================================
do $$
declare
  v_ref text := 'kqocfobichfvtsllkgdo';
  v_key text := 'PASTE_SERVICE_ROLE_KEY_HERE';
  r         record;
  v_new_cmd text;
  v_fixed   int := 0;
begin
  -- Guard is written so it survives a whole-file find-and-replace: it looks
  -- for the *shape* of an unedited value, never for the full placeholder
  -- token (which a global replace would rewrite here too, silently disabling
  -- the check).
  if v_key ~ 'PASTE' or v_key like '<%>' or length(v_key) < 40 then
    raise exception 'Set v_key to your real service_role key first.';
  end if;

  for r in
    select jobid, jobname, command
      from cron.job
     where jobname like 'tdsonly-%'
  loop
    v_new_cmd := replace(
                   replace(r.command, '<PROJECT_REF>', v_ref),
                   '<SERVICE_ROLE_KEY>', v_key
                 );

    if v_new_cmd is distinct from r.command then
      perform cron.alter_job(job_id := r.jobid, command := v_new_cmd);
      v_fixed := v_fixed + 1;
      raise notice 'fixed %', r.jobname;
    else
      raise notice 'already ok: %', r.jobname;
    end if;
  end loop;

  raise notice 'done — % job(s) rewritten', v_fixed;
end $$;
