-- ------------------------------------------------------------
-- Data da primeira atividade da organização
--
-- Serve ao período "All-Time" do relatório: em vez de mandar uma data fixa
-- bem antiga, o front pergunta quando o CRM começou e usa isso como início
-- da janela.
--
-- A diferença importa porque as séries diárias são geradas por
-- generate_series (037), um ponto por dia entre from e to. Com um chute tipo
-- 2000-01-01 o gráfico nasceria com ~9.700 pontos, quase todos zerados, e o
-- payload cresceria à toa. Com a data real ele cobre exatamente o período em
-- que existe dado.
--
-- Olha as duas pontas porque as abas fazem perguntas diferentes: o funil é
-- coorte por criação do lead (crm_contacts.created_at) e as vendas são fluxo
-- por data da venda (crm_sales.sold_at). Uma venda importada pode ser
-- anterior ao contato mais antigo, então a menor das duas é o começo de
-- verdade.
--
-- Organização vazia devolve null — o front trata como "sem período" e cai no
-- padrão de 30 dias, em vez de montar uma janela invertida.
-- ------------------------------------------------------------

create or replace function public.crm_first_activity_date()
returns date
language sql stable security definer set search_path = public as $$
  select least(
    (select min((c.created_at at time zone 'America/Sao_Paulo')::date)
       from public.crm_contacts c
      where c.organization_id = public.current_org_id()),
    (select min((v.sold_at at time zone 'America/Sao_Paulo')::date)
       from public.crm_sales v
      where v.organization_id = public.current_org_id())
  );
$$;

comment on function public.crm_first_activity_date() is
  'Dia mais antigo com atividade na organização — o menor entre a criação do '
  'primeiro contato e a data da primeira venda, no fuso de São Paulo. Início '
  'da janela "All-Time" dos relatórios. Null quando não há nada registrado. '
  'Atenção: contatos vindos de importação carregam a data do lote, não a data '
  'real do lead, e é ela que aparece aqui.';
