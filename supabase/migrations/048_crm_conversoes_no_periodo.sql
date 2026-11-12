-- ------------------------------------------------------------
-- Conversões OCORRIDAS no período (fluxo), não a coorte
--
-- O card "Convertidos" e a série da 037 respondem coorte: dos leads CRIADOS
-- na janela, quantos converteram. É a pergunta certa para medir qualidade de
-- origem — mas some com quem entrou em maio e fechou em julho. Olhando julho,
-- essa venda não aparece em lugar nenhum do funil.
--
-- Aqui é a outra pergunta, a que a operação faz no fim do mês: quantas
-- conversões aconteceram nestes dias, venha o lead de quando vier. Mesma
-- distinção que já existe entre o funil e o relatório de vendas (037).
--
-- REGRA DA PRIMEIRA CONVERSÃO
--
-- O min(h.created_at) é calculado sobre TODO o histórico do contato e só
-- depois a janela é aplicada. A ordem importa: filtrar antes faria um cliente
-- que converteu em janeiro e reentrou na etapa em julho contar como conversão
-- nova de julho. Cada cliente conta uma vez na vida, no dia em que converteu
-- pela primeira vez — a mesma regra da 037, para os dois números serem
-- comparáveis.
--
-- Devolve também quantas vieram de leads criados ANTES da janela: é
-- exatamente a diferença entre este número e o card de coorte ao lado, e sem
-- ela os dois parecem se contradizer na mesma tela.
-- ------------------------------------------------------------

create or replace function public.crm_report_conversions_in_period(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  conversions      bigint,
  from_older_leads bigint
)
language sql stable security definer set search_path = public as $$
  with primeira_conversao as (
    select
      h.contact_id,
      min(h.created_at) as convertido_em,
      min(c.created_at) as lead_criado_em
    from public.crm_stage_history h
    join public.crm_stages s on s.id = h.to_stage_id
    join public.crm_contacts c on c.id = h.contact_id
    where s.is_conversion
      and c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
    group by h.contact_id
  ),
  na_janela as (
    select * from primeira_conversao pc
    where pc.convertido_em >= public.crm_day_start(p_from)
      and pc.convertido_em < public.crm_day_start(p_to + 1)
  )
  select
    (select count(*) from na_janela)::bigint,
    (select count(*) from na_janela n
      where n.lead_criado_em < public.crm_day_start(p_from))::bigint;
$$;

comment on function public.crm_report_conversions_in_period(date, date, text) is
  'Conversões ocorridas na janela, independentemente de quando o lead entrou '
  '(fluxo). Cada cliente conta uma vez, na primeira conversão da vida dele. '
  'from_older_leads diz quantas vieram de leads anteriores à janela — é a '
  'diferença para o card de coorte "Convertidos", que só olha quem foi criado '
  'no período.';
