-- ============================================================
-- Reembolso com NOTAS e ANEXOS
--
-- A 101/102 guardam só quando e quanto foi devolvido. Faltava o porquê e a
-- prova: o motivo do cliente, o comprovante do estorno, o print da conversa.
-- Agora quem marca o reembolso escreve uma nota e anexa arquivos, e o
-- reembolso vira clicável no drawer e no relatório para abrir tudo isso.
--
--   crm_sales.refund_note        texto livre do reembolso
--   crm_sale_refund_files        um arquivo por linha, ligado à venda
--   bucket crm-refunds (PRIVADO) os arquivos em si, em <org>/<venda>/...
--
-- Aceita PDF e imagem (png, jpg, webp, gif...). A tela COMPRIME antes de
-- subir: imagem é redimensionada e vira WebP; PDF vai em gzip (encoding =
-- 'gzip') e é descompactado no navegador ao abrir. O limite de 20 MB vale
-- para o arquivo já comprimido.
--
-- ESPAÇO LIVRE: o plano Free do Supabase tem 1 GB de storage para o projeto
-- inteiro (media + crm-refunds). crm_storage_usage() devolve o usado e o
-- teto, e a tela recusa o anexo que não cabe, com aviso. Mudou de plano?
-- Troque o teto na função (é a única constante).
--
-- O bucket é privado, ao contrário do 'media' (004): o 'media' é público
-- porque a Evolution baixa pela URL, e o worker apaga o que já foi enviado.
-- Comprovante de estorno tem dado bancário e fica para sempre — a tela abre
-- por URL assinada.
--
-- NADA DISSO AVISA NINGUÉM. A trigger de carimbo (102) é "update of
-- refunded_at, refunded_cents" e o webhook de alteração (088) só olha valor,
-- pagamento, data e canal: refund_note passa calada, como refunded_at.
--
-- Desfazer o reembolso NÃO apaga nota nem anexos: se a venda for marcada de
-- novo, eles voltam a aparecer. Só aparecem enquanto a venda está
-- reembolsada.
--
-- Quem LÊ: quem vê vendas ou quem vê relatórios (o card do relatório abre o
-- detalhe sem precisar da permissão de vendas). Quem ESCREVE: quem lança
-- venda (crm.vendas.editar), a mesma régua do update em crm_sales (055).
--
-- Aplicar pelo SQL Editor, depois da 102 e ANTES do deploy da tela. Nunca
-- por db push.
-- ============================================================

alter table public.crm_sales
  add column if not exists refund_note text;

comment on column public.crm_sales.refund_note is
  'Nota do reembolso (103): motivo, combinado com o cliente. Só é mostrada '
  'enquanto refunded_at estiver preenchido; desfazer o reembolso não apaga.';

-- ------------------------------------------------------------
-- Anexos
-- ------------------------------------------------------------
create table if not exists public.crm_sale_refund_files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Excluir a venda apaga a linha; o arquivo no bucket fica órfão (a tela
  -- não exclui venda reembolsada sem passar pela lixeira, e o custo é baixo).
  sale_id         uuid not null references public.crm_sales(id) on delete cascade,
  -- Caminho no bucket crm-refunds: <org>/<venda>/<timestamp>-<nome>.
  path            text not null unique,
  name            text not null,
  -- Tamanho gravado no bucket (já comprimido) e o original, para a tela.
  size_bytes      bigint,
  original_bytes  bigint,
  -- Tipo do arquivo como o usuário vê (o original, ou image/webp quando a
  -- imagem foi convertida).
  mime_type       text,
  -- 'gzip' = o objeto no bucket é o arquivo em gzip (PDF); null = cru.
  encoding        text check (encoding is null or encoding = 'gzip'),
  created_by      uuid default auth.uid() references public.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

comment on table public.crm_sale_refund_files is
  'Arquivos anexados ao reembolso de uma venda (103). O conteúdo fica no '
  'bucket privado crm-refunds, no caminho de path.';

create index if not exists idx_crm_sale_refund_files_sale
  on public.crm_sale_refund_files (sale_id, created_at);

alter table public.crm_sale_refund_files enable row level security;

drop policy if exists crm_sale_refund_files_select on public.crm_sale_refund_files;
create policy crm_sale_refund_files_select on public.crm_sale_refund_files
  for select using (
    organization_id = public.current_org_id()
    and (public.current_user_can('crm.vendas.ver')
         or public.current_user_can('crm.relatorios.ver'))
  );

-- O with check confere que a venda é da organização: sem ele dava para
-- pendurar arquivo na venda de outra org conhecendo o id.
drop policy if exists crm_sale_refund_files_insert on public.crm_sale_refund_files;
create policy crm_sale_refund_files_insert on public.crm_sale_refund_files
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.vendas.editar')
    and exists (
      select 1 from public.crm_sales v
      where v.id = sale_id and v.organization_id = public.current_org_id()
    )
  );

drop policy if exists crm_sale_refund_files_delete on public.crm_sale_refund_files;
create policy crm_sale_refund_files_delete on public.crm_sale_refund_files
  for delete using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.vendas.editar')
  );

-- ------------------------------------------------------------
-- Bucket privado
-- ------------------------------------------------------------
-- application/gzip é o PDF comprimido. O update cobre quem rodar de novo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('crm-refunds', 'crm-refunds', false, 20971520, -- 20 MB por arquivo
        array['image/*', 'application/pdf', 'application/gzip'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "crm_refunds_select" on storage.objects;
create policy "crm_refunds_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'crm-refunds'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (public.current_user_can('crm.vendas.ver')
         or public.current_user_can('crm.relatorios.ver'))
  );

drop policy if exists "crm_refunds_upload" on storage.objects;
create policy "crm_refunds_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'crm-refunds'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_user_can('crm.vendas.editar')
  );

drop policy if exists "crm_refunds_delete" on storage.objects;
create policy "crm_refunds_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'crm-refunds'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_user_can('crm.vendas.editar')
  );

-- ------------------------------------------------------------
-- Detalhe de um reembolso (o card clicável)
--
-- security definer porque o relatório é aberto por quem pode não ter
-- crm.vendas.ver — e aí a RLS de crm_sales (055) devolveria zero linha.
-- A regra de leitura é a mesma dos anexos.
-- ------------------------------------------------------------
create or replace function public.crm_sale_refund_detail(p_sale_id uuid)
returns table(
  sale_id          uuid,
  contact_id       uuid,
  name             text,
  phone            text,
  channel          text,
  value_cents      bigint,
  refund_cents     bigint,
  partial          boolean,
  sold_at          timestamptz,
  refunded_at      timestamptz,
  refunded_by_name text,
  refund_note      text
)
language sql stable security definer set search_path = public as $$
  select
    v.id,
    v.contact_id,
    c.name,
    c.phone,
    c.channel,
    v.value_cents::bigint,
    least(coalesce(v.refunded_cents, v.value_cents), v.value_cents)::bigint,
    (v.refunded_cents is not null and v.refunded_cents < v.value_cents),
    v.sold_at,
    v.refunded_at,
    coalesce(nullif(trim(u.full_name), ''), u.email),
    v.refund_note
  from public.crm_sales v
  join public.crm_contacts c on c.id = v.contact_id
  left join public.users u on u.id = v.refunded_by
  where v.id = p_sale_id
    and v.organization_id = public.current_org_id()
    and v.refunded_at is not null
    and (public.current_user_can('crm.vendas.ver')
         or public.current_user_can('crm.relatorios.ver'));
$$;

comment on function public.crm_sale_refund_detail(uuid) is
  'Detalhe do reembolso de uma venda: valores, datas, quem marcou e a nota '
  '(103). Os anexos vêm de crm_sale_refund_files.';

revoke all on function public.crm_sale_refund_detail(uuid) from public, anon;
grant execute on function public.crm_sale_refund_detail(uuid) to authenticated;

-- ------------------------------------------------------------
-- Espaço do storage
--
-- Soma o tamanho de TODOS os objetos do projeto (a cota é do projeto, não do
-- bucket). Só devolve números agregados, então pode ler storage.objects
-- inteiro sem vazar nada de outra organização.
-- ------------------------------------------------------------
create or replace function public.crm_storage_usage()
returns table(used_bytes bigint, limit_bytes bigint)
language sql stable security definer set search_path = public, storage as $$
  select
    coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint,
    1073741824::bigint -- 1 GB, plano Free. Trocar aqui se o plano mudar.
  from storage.objects o;
$$;

comment on function public.crm_storage_usage() is
  'Bytes usados no storage do projeto e o teto do plano (103). A tela de '
  'reembolso recusa anexo que não cabe.';

revoke all on function public.crm_storage_usage() from public, anon;
grant execute on function public.crm_storage_usage() to authenticated;

-- Conferência: deve dar 1, true, true, true, true.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'crm_sales'
      and column_name = 'refund_note') as coluna_nova,
  to_regclass('public.crm_sale_refund_files') is not null as tabela_ok,
  exists (select 1 from storage.buckets where id = 'crm-refunds') as bucket_ok,
  to_regprocedure('public.crm_sale_refund_detail(uuid)') is not null as rpc_ok,
  to_regprocedure('public.crm_storage_usage()') is not null as uso_ok;
