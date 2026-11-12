-- ============================================================
-- Relatório: leads sem origem
--
-- Origem em branco tem custo direto agora que ela decide envio para a Meta
-- (033): lead de anúncio sem origem preenchida e sem ctwa_clid não vira
-- conversão em lugar nenhum. Este relatório é a lista de trabalho para
-- fechar esse buraco — quem está sem origem, em que etapa e desde quando.
--
-- "SEM ORIGEM" = null ou só espaço. O relatório por origem (025) já ignora
-- esses contatos; aqui eles são justamente o assunto.
--
-- DOIS NÚMEROS POR ETAPA, DE PROPÓSITO
--
-- leads          = criados no período selecionado (o que entrou agora sem
--                  origem — mede se o cadastro está melhorando);
-- leads_all_time = a dívida acumulada, independente de período.
--
-- Sem o segundo, um filtro de 7 dias esconderia 3 mil contatos antigos sem
-- origem e daria a impressão de que o problema é pequeno.
-- ============================================================

-- ------------------------------------------------------------
-- Resumo por etapa. Inclui a linha de quem está fora do funil
-- (stage_id nulo), que é onde a base antiga costuma estar.
-- ------------------------------------------------------------
create or replace function public.crm_report_no_origem_by_stage(
  days int default 30,
  p_channel text default null
)
returns table(
  stage_id       uuid,
  stage_name     text,
  stage_color    text,
  leads          bigint,
  leads_all_time bigint,
  value_cents    bigint
)
language sql stable security definer set search_path = public as $$
  select
    s.id,
    s.name,
    s.color,
    count(*) filter (
      where c.created_at >= now() - make_interval(days => days)
    )::bigint,
    count(*)::bigint,
    coalesce(sum(c.value_cents) filter (
      where c.created_at >= now() - make_interval(days => days)
    ), 0)::bigint
  from public.crm_contacts c
  left join public.crm_stages s on s.id = c.stage_id
  where c.organization_id = public.current_org_id()
    and (c.origem is null or btrim(c.origem) = '')
    and (p_channel is null or c.channel = p_channel)
  group by s.id, s.name, s.color
  order by 4 desc, 5 desc, s.name nulls last;
$$;

-- ------------------------------------------------------------
-- A lista em si: quem são, por data de criação (mais recentes primeiro).
--
-- Teto em p_limit porque a tela não pagina este bloco — o número real por
-- etapa vem da função acima, então o resumo continua correto mesmo quando a
-- lista é cortada. Para trabalhar a fila inteira, a aba Contatos tem o
-- filtro "sem origem", com paginação e edição.
-- ------------------------------------------------------------
create or replace function public.crm_report_no_origem_list(
  days int default 30,
  p_channel text default null,
  p_limit int default 200
)
returns table(
  id          uuid,
  name        text,
  phone       text,
  channel     text,
  stage_id    uuid,
  stage_name  text,
  stage_color text,
  created_at  timestamptz,
  value_cents bigint
)
language sql stable security definer set search_path = public as $$
  select
    c.id,
    c.name,
    c.phone,
    c.channel,
    c.stage_id,
    s.name,
    s.color,
    c.created_at,
    c.value_cents
  from public.crm_contacts c
  left join public.crm_stages s on s.id = c.stage_id
  where c.organization_id = public.current_org_id()
    and (c.origem is null or btrim(c.origem) = '')
    and c.created_at >= now() - make_interval(days => days)
    and (p_channel is null or c.channel = p_channel)
  order by c.created_at desc
  limit greatest(p_limit, 1);
$$;

-- Suporta os dois: sem ele, cada abertura do relatório varre a tabela de
-- contatos inteira procurando os poucos que estão sem origem.
create index if not exists idx_crm_contacts_sem_origem
  on public.crm_contacts(organization_id, created_at desc)
  where origem is null or btrim(origem) = '';
