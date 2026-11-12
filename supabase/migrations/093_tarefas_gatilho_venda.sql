-- ============================================================
-- Toda venda vira tarefa
--
-- Esta é a ÚNICA migration do módulo de tarefas que encosta num objeto deste
-- repositório. Todo o resto vive em ../tarefas-ph/supabase/migrations (série
-- t01..t08) e só cria coisa nova — inclusive as permissões, que são próprias
-- do módulo e NÃO tocam role_permissions().
--
-- Mora aqui porque o gatilho fica pendurado em crm_sales: quem for auditar
-- essa tabela amanhã precisa achá-lo no histórico deste repo.
--
-- APLICAR DEPOIS de t01..t09 — mas se aplicar antes, não quebra nada: o
-- gatilho confere se o módulo existe e não faz nada até existir.
--
-- POR QUE GATILHO E NÃO O WEBHOOK DO PAINEL
--
-- saleWebhook.ts avisa o n8n, mas o próprio arquivo diz: "NUNCA É CHAMADO
-- POR AUTOMAÇÃO. Venda que entra pela crm-api (n8n) ou por trigger não passa
-- por aqui." Pendurar a criação do cartão ali significaria que toda venda
-- vinda da API não gera tarefa — em silêncio, sem erro, descoberto semanas
-- depois. O gatilho no banco pega os dois caminhos.
--
-- NADA AQUI PODE DERRUBAR UM LANÇAMENTO DE VENDA
--
-- after insert: a venda já está gravada quando isto roda. E o bloco inteiro
-- é envolvido por `exception when others`, que deposita a falha em
-- task_integration_errors e devolve normal. Quadro padrão apagado, lista
-- faltando, Drive fora do ar — nada disso pode desfazer o registro de uma
-- venda, que é o processo mais crítico da operação.
--
-- TODA VENDA, NÃO SÓ A PRIMEIRA
--
-- A regra era "só a primeira compra do contato"; mudou em 13/09/2026 para
-- toda venda. Faz sentido: cada pedido é um trabalho a entregar, e o segundo
-- não é menos trabalho que o primeiro.
--
-- Consequência a notar: um cliente que compra três vezes ganha três cartões,
-- e sem data no título eles seriam visualmente idênticos na coluna. Por isso
-- o dia entra no nome.
--
-- O vínculo é por contact_id direto, sem casar telefone: estar no mesmo banco
-- elimina a etapa inteira, e com ela o risco de o cliente com e sem o 9
-- virar dois.
--
-- A PASTA DO DRIVE NÃO É PROBLEMA DESTA MIGRATION
--
-- É uma pasta por TAREFA (decisão de 13/09/2026), e quem a pede é
-- task_pede_pasta, gatilho de insert em task_cards (t05) — que pega cartão
-- de qualquer origem, inclusive o criado à mão no quadro. Se este gatilho
-- também pedisse, toda venda geraria duas pastas para o mesmo cartão.
--
-- Ainda assim, configure o destino uma vez (é o t05 que usa):
--
--   alter database postgres
--     set app.task_drive_hook = 'https://<ref>.supabase.co/functions/v1/drive';
--   alter database postgres
--     set app.task_drive_key = '<service role key>';
--
-- Sem essas configurações o gatilho cria o cartão e não avisa ninguém —
-- de propósito, para poder ser aplicado antes de a Edge Function existir.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

create or replace function public.task_card_da_venda()
returns trigger
-- lock_timeout no cabeçalho da FUNÇÃO, não `set local`: assim vale só
-- enquanto ela roda e é restaurado na saída. Com `set local` o limite
-- vazaria para o resto da transação da venda.
--
-- Por que existe: se o insert em task_cards ficar preso esperando lock, quem
-- estoura primeiro é o statement_timeout — e esse erro (query_canceled) NÃO
-- é capturado por `exception when others`. Ele escaparia e derrubaria a
-- venda. Com o limite de 2s, o que estoura é lock_not_available, que é
-- capturável, vira log e deixa a venda passar.
language plpgsql security definer
  set search_path = public
  set lock_timeout = '2s' as $$
declare
  v_card uuid;
begin
  -- O MÓDULO ESTÁ INSTALADO?
  --
  -- Se esta migration for aplicada antes das t01..t09, nada aqui existe — e
  -- o tratamento de exceção lá embaixo também não teria onde gravar. Sem
  -- esta guarda, o erro escaparia e DERRUBARIA O LANÇAMENTO DA VENDA, que é
  -- exatamente o que este arquivo inteiro existe para impedir.
  --
  -- Com ela, aplicar fora de ordem é inofensivo: o gatilho não faz nada até
  -- as tabelas existirem, e passa a funcionar sozinho assim que existirem.
  if to_regclass('public.task_cards') is null
     or to_regclass('public.task_integration_errors') is null then
    return null;
  end if;

  -- O cartão nasce no espaço padrão, na coluna marcada como is_inbox — que
  -- o seed cria com o nome "Nova Tarefa". Se o admin mover a flag para outra
  -- coluna, o cartão passa a cair lá, sem migration: é esse o ponto de a
  -- flag existir em vez de o nome estar no código.
  insert into public.task_cards
         (organization_id, board_id, list_id, titulo, contact_id, sale_id, created_by)
  select new.organization_id, b.id, l.id,
         -- "Studio Vitória · 5 criativos · 13/09": o cliente diz de quem é,
         -- a quantidade diz o tamanho, e a data separa uma compra da outra.
         -- Sem ela, o mesmo cliente comprando duas vezes geraria dois
         -- cartões idênticos na coluna.
         coalesce(ct.name, 'Cliente sem nome') ||
           case when new.creatives > 0
                then ' · ' || new.creatives || ' criativo' ||
                     case when new.creatives > 1 then 's' else '' end
                else '' end ||
           ' · ' || to_char(coalesce(new.sold_at, now()), 'DD/MM'),
         new.contact_id, new.id, new.created_by
    from public.task_boards b
    join public.task_lists  l  on l.board_id = b.id and l.is_inbox and not l.arquivada
    join public.crm_contacts ct on ct.id = new.contact_id
   where b.organization_id = new.organization_id
     and b.is_default
     and not b.arquivado
  returning id into v_card;

  if v_card is null then
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id,
            'Nenhum espaço padrão com coluna de entrada (is_inbox) nesta organização',
            jsonb_build_object('organization_id', new.organization_id));
    return null;
  end if;

  -- A pasta do Drive NÃO é pedida aqui. Quem pede é task_pede_pasta (t05),
  -- gatilho de insert em task_cards, que vale para cartão de qualquer
  -- origem. Duplicar a chamada aqui criaria duas pastas para o mesmo cartão
  -- toda vez que uma venda gerasse um.
  return null;

exception when others then
  -- A VENDA JÁ ESTÁ GRAVADA. Falha aqui vira log, nunca rollback.
  --
  -- E o próprio log é protegido: se gravar o erro também falhar, engole-se o
  -- segundo erro. Tratamento de exceção que estoura derruba justamente a
  -- transação que ele deveria estar salvando.
  begin
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id, sqlerrm,
            jsonb_build_object('contact_id', new.contact_id, 'card_id', v_card));
  exception when others then
    raise warning 'tarefas: falha ao registrar falha da venda %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

comment on function public.task_card_da_venda() is
  'Cria o cartão de produção a cada venda. À prova de exceção: qualquer '
  'falha vira linha em task_integration_errors e a venda segue gravada.';

-- O nome antigo dizia "primeira venda" e viraria mentira. Estes dois drops
-- limpam a versão anterior de quem já tinha aplicado — sem eles ficariam
-- DOIS gatilhos em crm_sales, e cada venda criaria dois cartões.
drop trigger  if exists trg_crm_sales_primeira_venda on public.crm_sales;
drop function if exists public.task_card_da_primeira_venda();

drop trigger if exists trg_crm_sales_venda on public.crm_sales;
create trigger trg_crm_sales_venda
  after insert on public.crm_sales
  for each row execute function public.task_card_da_venda();

-- ------------------------------------------------------------
-- CONFERIR DEPOIS DE APLICAR
--
--   -- 1. nenhuma venda existente foi afetada (o gatilho é só after insert)
--   select count(*) from public.task_cards;   -- deve continuar como estava
--
--   -- 2. lançar uma venda de teste e conferir que:
--   --    a) a venda gravou
--   --    b) apareceu um cartão na coluna de entrada do espaço padrão
--   --    c) task_integration_errors continua vazia
--
--   select origem, erro, created_at
--     from public.task_integration_errors
--    order by created_at desc limit 10;
--
-- Se algo der errado, DESLIGAR é uma linha e não perde nada:
--
--   drop trigger trg_crm_sales_venda on public.crm_sales;
-- ------------------------------------------------------------
