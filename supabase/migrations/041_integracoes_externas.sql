-- ============================================================
-- URLs de integração externa (n8n, sistema de comissão) — por banco
--
-- No projeto da PH estas URLs eram constantes dentro das funções (068, 070,
-- 079, 082, 088, 104). Na cópia da Infuse elas apontariam para o n8n e para
-- o site da PH: toda venda da Infuse seria enviada para lá. Agora cada
-- função pergunta a URL a esta tabela e, sem linha cadastrada, NÃO ENVIA
-- NADA — o aviso fica desligado até a Infuse ter o fluxo dela.
--
-- Para ligar um aviso (SQL Editor, como service role):
--
--   insert into public.integration_urls (key, url) values
--     ('n8n_venda_manual',       'https://SEU-N8N/webhook/...'),
--     ('n8n_fusao_venda_do_dia', 'https://SEU-N8N/webhook/...'),
--     ('n8n_venda_excluida',     'https://SEU-N8N/webhook/...'),
--     ('n8n_venda_atualizada',   'https://SEU-N8N/webhook/...'),
--     ('comissao_reembolso',     'https://SEU-SISTEMA/api/...')
--   on conflict (key) do update set url = excluded.url, updated_at = now();
--
-- Sem políticas de RLS de propósito: só as funções security definer e o
-- service role leem. URL de webhook é segredo (quem a tem injeta dados).
-- ============================================================

create table if not exists public.integration_urls (
  key        text primary key,
  url        text not null,
  updated_at timestamptz not null default now()
);

alter table public.integration_urls enable row level security;

create or replace function public.integration_url(p_key text)
returns text
language sql stable security definer set search_path = public as $$
  select nullif(trim(url), '') from public.integration_urls where key = p_key;
$$;

revoke all on function public.integration_url(text) from public, anon, authenticated;

comment on function public.integration_url(text) is
  'URL cadastrada para a integração, ou null quando ela está desligada.';
