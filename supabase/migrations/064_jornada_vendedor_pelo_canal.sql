-- ============================================================
-- Jornada: o vendedor é o canal
--
-- crm_report_journey_by_assignee atribuía o lead assim: assigned_to do
-- contato e, na falta dele, quem moveu a etapa primeiro (changed_by), com
-- inferred_leads contando os deduzidos.
--
-- Os dois campos são cegos neste ambiente:
--
--   assigned_to  nenhuma tela e nenhum endpoint preenchem. O crm-api que o
--                n8n chama não tem campo de responsável.
--   changed_by   fica nulo em tudo que a automação escreve, e é ela que
--                escreve quase tudo — o vendedor conversa no WhatsApp e o
--                n8n lê a conversa e atualiza o CRM.
--
-- Resultado: uma tabela de desempenho com quase todo lead em "Sem
-- atendente". Não é um número ruim, é um número que não existe.
--
-- O QUE SUBSTITUI
--
-- Cada vendedor atende pelo próprio número de WhatsApp, então o canal do
-- contato JÁ É o vendedor. É dado que existe, está preenchido, vem do
-- cadastro do lead e não depende de ninguém lembrar de marcar responsável.
--
-- Some inferred_leads: não há mais dedução, a atribuição é direta.
--
-- ORDEM DE DEPLOY
--
-- Esta migration TROCA as colunas devolvidas (user_id/user_name/
-- inferred_leads saem, vendedor entra). A tela nova lê `vendedor`, então
-- aplique isto ANTES de publicar o frontend — no intervalo, o card
-- "Conversão por vendedor" fica com as linhas vazias.
-- ============================================================

do $$
begin
  if to_regprocedure('public.crm_report_journey_by_assignee(date, date, text, text)') is null then
    raise exception 'Aplique a migration 063 antes desta';
  end if;
end $$;

drop function if exists public.crm_report_journey_by_assignee(date, date, text, text);

create or replace function public.crm_report_journey_by_assignee(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  vendedor             text,
  leads                bigint,
  converted            bigint,
  conversion_rate      numeric,
  revenue_cents        bigint,
  avg_hours_to_convert numeric
)
language sql stable security definer set search_path = public, extensions as $$
  with coorte as (
    select c.id, c.created_at, c.channel, c.value_cents
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  medido as (
    select
      co.channel,
      co.created_at,
      co.value_cents,
      (
        select min(h.created_at)
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = co.id and s.is_conversion
      ) as conv_at
    from coorte co
  )
  select
    -- Canal em branco não é vendedor: vira uma linha só, no fim da tabela.
    nullif(btrim(coalesce(m.channel, '')), ''),
    count(*)::bigint,
    count(m.conv_at)::bigint,
    round(100.0 * count(m.conv_at) / nullif(count(*), 0), 1),
    coalesce(sum(m.value_cents) filter (where m.conv_at is not null), 0)::bigint,
    round(
      (avg(extract(epoch from (m.conv_at - m.created_at)) / 3600.0)
        filter (where m.conv_at is not null))::numeric, 1
    )
  from medido m
  group by nullif(btrim(coalesce(m.channel, '')), '')
  -- Sem canal vai para o fim: é linha de diagnóstico, não de ranking.
  order by (nullif(btrim(coalesce(m.channel, '')), '') is null),
           count(m.conv_at) desc, count(*) desc;
$$;

comment on function public.crm_report_journey_by_assignee(date, date, text, text) is
  'Leads e conversões por VENDEDOR na coorte da janela, atribuídos pelo canal '
  'do contato — cada vendedor atende pelo próprio número. Não usa assigned_to '
  'nem changed_by: o primeiro ninguém preenche e o segundo é nulo em tudo que '
  'a automação escreve.';
