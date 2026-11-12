-- ============================================================
-- Arquiva convertidos: sai da etapa depois de 5 dias
--
-- A etapa de conversão vira depósito — quem fechou continua ocupando coluna
-- para sempre. Aqui o contato sai do funil (stage_id = null) 5 dias depois
-- de entrar na etapa, e passa a aparecer só na aba Contatos.
--
-- POR QUE O HISTÓRICO NÃO SE PERDE
--
-- Nenhuma métrica de conversão olha a etapa ATUAL do contato: todas passam
-- por crm_has_converted (016), que pergunta ao crm_stage_history se o
-- contato já ENTROU alguma vez numa etapa de conversão. Receita, taxa,
-- ticket médio e tempo até converter seguem idênticos depois do arquivamento.
--
-- O próprio UPDATE ainda grava uma linha nova no histórico (etapa de
-- conversão → null) pelo trigger crm_track_stage_change, então a saída fica
-- registrada e visível no painel do contato.
--
-- E NÃO DISPARA CONVERSÃO DE NOVO
--
-- No trigger, `select is_conversion ... where id = new.stage_id` com
-- stage_id nulo não acha linha, v_converts fica nulo e o coalesce derruba a
-- condição — nenhum evento é enfileirado para a Meta. Como reforço, a
-- migration 028 já impede um segundo evento por contato.
--
-- Sem laço: uma vez com stage_id nulo, o contato deixa de casar com o
-- filtro (que exige etapa de conversão) e nunca mais é tocado.
-- ============================================================

create or replace function public.crm_archive_converted(p_days int default 5)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  -- Roda para TODAS as organizações: é chamada pelo pg_cron, fora de
  -- sessão de usuário, então não filtra por current_org_id().
  with alvo as (
    select c.id
    from public.crm_contacts c
    join public.crm_stages s on s.id = c.stage_id
    where s.is_conversion
      and c.stage_changed_at < now() - make_interval(days => p_days)
  )
  update public.crm_contacts c
  set stage_id = null
  from alvo
  where c.id = alvo.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.crm_archive_converted(int) is
  'Tira do funil os contatos que estão na etapa de conversão há mais de '
  'p_days dias. O histórico de conversão é preservado — os relatórios leem '
  'crm_stage_history, não a etapa atual.';

-- Uma vez por dia, 04:00 UTC (01:00 em São Paulo): é limpeza, não precisa
-- ser reativa como o worker de eventos.
select cron.schedule(
  'ph-groups-crm-archive-converted',
  '0 4 * * *',
  $$ select public.crm_archive_converted(5); $$
);
