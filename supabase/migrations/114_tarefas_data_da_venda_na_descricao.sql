-- ============================================================
-- Tarefas: data da venda na descrição dos cartões recuperados pela 113
--
-- Uso único, depois da 113. Os cartões que a 113 criou depois do quadro ser
-- renomeado para "HEAD" (vendas com erro "Quadro não encontrado" já marcado
-- como resolvido em task_integration_errors) ganham na descrição:
--
--   Data da venda: DD/MM/AAAA
--
-- (dia em São Paulo, a partir de crm_sales.sold_at). Se o cartão já tem
-- descrição, a linha entra no topo e o texto existente é mantido.
-- Cartão que já tem "Data da venda:" na descrição é pulado: rodar de novo não
-- duplica. O título não muda.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

with alvo as (
  select c.id,
         'Data da venda: ' ||
           to_char(s.sold_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') as linha
    from public.task_cards c
    join public.crm_sales s on s.id = c.sale_id
   where not c.arquivado
     and s.id in (
           select e.referencia
             from public.task_integration_errors e
            where e.origem = 'crm_sales.venda'
              and e.resolvido
              and e.erro like 'Quadro não encontrado:%')
     and coalesce(c.descricao, '') not like '%Data da venda:%'
)
update public.task_cards c
   set descricao = case when btrim(coalesce(c.descricao, '')) = ''
                        then a.linha
                        else a.linha || E'\n\n' || c.descricao end
  from alvo a
 where c.id = a.id;

-- CONFERIR:
--   select titulo, descricao from public.task_cards
--    where descricao like 'Data da venda:%' order by created_at desc limit 20;
