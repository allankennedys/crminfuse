-- ============================================================
-- Corrige wa_ingest_message (155): `substring(btrim(p_body) from 1 for 1)::int`
-- era calculado mesmo sem nenhuma linha casar com o filtro, então toda mensagem
-- recebida que começasse com letra ("Oi") dava "invalid input syntax for type
-- integer" e era recusada. A nota agora sai do regexp_match, que devolve NULL
-- quando não há número de 1 a 5 (a conversão de NULL nunca falha).
-- ============================================================
do $mig$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'wa_ingest_message' and p.prokind = 'f';
  if v_def is null then raise exception 'wa_ingest_message não encontrada'; end if;
  v_new := replace(v_def,
    'score = substring(btrim(p_body) from 1 for 1)::int',
    'score = ((regexp_match(btrim(coalesce(p_body, '''')), ''^([1-5])''))[1])::int');
  if v_new = v_def then raise exception 'wa_ingest_message: trecho esperado não encontrado'; end if;
  execute v_new;
end
$mig$;
