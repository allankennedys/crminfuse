-- ============================================================
-- Mesmo cliente com e sem o 9 extra é o mesmo contato
--
-- Celular brasileiro ganhou um 9 na frente do número (55 48 9953-3582 →
-- 55 48 99953-3582). Na prática as duas formas circulam: o WhatsApp devolve
-- o JID de um jeito dependendo do DDD, o cliente digita de outro, a planilha
-- antiga tem a forma velha. Como a API casava com igualdade exata, o mesmo
-- cliente virava dois contatos — cada um com suas vendas, e a "primeira
-- venda" acontecia duas vezes (duas conversões, duas idas à Meta).
--
-- A CHAVE
--
-- phone_key normaliza para a forma SEM o 9: só dígitos e, quando for número
-- brasileiro de 13 dígitos com 9 depois do DDD, o 9 sai. As duas grafias
-- passam a produzir a mesma chave.
--
-- Escolhi a forma curta como canônica porque ela é derivável da longa sem
-- ambiguidade; o contrário não é (não dá para saber se um número de 12
-- dígitos é celular antigo ou fixo). O campo phone continua guardando
-- exatamente o que chegou — a chave é só para comparar.
--
-- Coluna gerada, não trigger: o banco mantém sozinho, inclusive em update
-- direto por SQL, e não existe caminho que grave contato sem a chave.
--
-- FIXO NÃO É AFETADO: telefone fixo brasileiro tem 12 dígitos (55 + DDD +
-- 8), então nunca entra na regra dos 13.
-- ============================================================

create or replace function public.crm_phone_key(p_phone text)
returns text
language sql immutable set search_path = public as $$
  select case
    when t.d = '' then null
    -- 55 + DDD(2) + 9 + 8 dígitos = 13: tira o 9 da quinta posição.
    when length(t.d) = 13 and left(t.d, 2) = '55' and substr(t.d, 5, 1) = '9'
      then left(t.d, 4) || substr(t.d, 6)
    else t.d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) t;
$$;

comment on function public.crm_phone_key(text) is
  'Telefone reduzido à forma canônica (sem o 9 extra do celular brasileiro) '
  'para comparar contatos. Guardar continua guardando o número como veio.';

alter table public.crm_contacts
  add column if not exists phone_key text
  generated always as (public.crm_phone_key(phone)) stored;

create index if not exists idx_crm_contacts_phone_key
  on public.crm_contacts(organization_id, phone_key)
  where phone_key is not null;

-- ------------------------------------------------------------
-- Busca por telefone, tolerante ao 9
--
-- security INVOKER de propósito: a RLS de crm_contacts continua valendo
-- para o usuário do painel (só a própria organização), e o service role da
-- Edge Function passa direto, como no resto. Com security definer, um
-- usuário autenticado leria contato de outra org só mandando o uuid dela.
--
-- QUEM GANHA O DESEMPATE
--
-- Quem já tem venda, e só depois o mais antigo.
--
-- "O mais antigo" sozinho parece certo — é o registro original do lead — mas
-- aqui elege a coisa errada: os contatos vindos da importação carregam
-- created_at de 2025-01-01 e são carcaças, sem venda e com etapa velha. O
-- contato real, criado pelo WhatsApp, é sempre mais novo. Nos três pares
-- duplicados que existiam quando isto foi escrito, o mais antigo era o husk
-- em todos.
--
-- Devolver o husk é a pior falha possível neste caminho: ele tem zero vendas,
-- então a venda seguinte seria tratada como PRIMEIRA — movendo o contato para
-- a conversão e enfileirando um evento novo para a Meta (o guard de um evento
-- por contato da 028/033 é por contato, e o husk nunca teve nenhum). Cliente
-- que já converteu apareceria comprando de novo, e a Conversions API não tem
-- como desfazer.
--
-- Entre dois contatos que já venderam, o mais antigo continua ganhando — mas
-- esse caso é ambíguo de verdade e a 045 o deixa para revisão humana.
-- ------------------------------------------------------------
create or replace function public.crm_contact_by_phone(p_org uuid, p_phone text)
returns setof public.crm_contacts
language sql stable set search_path = public as $$
  select c.*
  from public.crm_contacts c
  where c.organization_id = p_org
    and c.phone_key is not null
    and c.phone_key = public.crm_phone_key(p_phone)
  order by (coalesce(c.sales_count, 0) > 0) desc, c.created_at
  limit 1;
$$;

comment on function public.crm_contact_by_phone(uuid, text) is
  'Contato da organização cujo telefone bate com o informado ignorando o 9 '
  'extra. Havendo mais de um, ganha quem já tem venda e, entre iguais, o mais '
  'antigo — nunca a carcaça importada, que faria a próxima venda contar como '
  'primeira e duplicar a conversão na Meta.';
