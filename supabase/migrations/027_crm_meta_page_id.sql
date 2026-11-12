-- ============================================================
-- Página do Facebook no evento de conversão (CTWA)
--
-- Diagnóstico: TODO evento com ctwa_clid falhava com
--   code 100 / error_subcode 2804116
--   "não tem um parâmetro page_id ou whatsapp_business_account_id"
--
-- O ctwa_clid sozinho não basta: a Meta precisa saber de qual ativo do
-- negócio veio a conversa para validar o clique. Ela aceita a Página do
-- Facebook (page_id) OU a conta de WhatsApp Business (WABA).
--
-- Usamos page_id. O WABA só existe para números na Cloud API oficial, e os
-- nossos rodam por Evolution (WhatsApp Web), que é incompatível com ela.
--
-- Comprovado contra a API de produção:
--   page_id da PH (977009182142874) ..... HTTP 200, aceito
--   page_id inexistente ................. 2804070 "page_id inválido"
--   page_id real de outra empresa ....... 2804072 "ctwa_clid deve ser
--                                          gerado usando o mesmo page_id"
--
-- O caso 2804072 é o que garante a atribuição: a Meta confere se o clique
-- nasceu naquela Página. Página errada falha alto, não silenciosamente —
-- então um erro de configuração aparece no crm_events.error, não vira
-- receita atribuída ao anúncio errado.
--
-- Deploy: esta migration ANTES do crm-worker atualizado. O worker novo lê
-- meta_page_id; se subir antes da coluna existir, o select quebra e para
-- também as conversões sem anúncio, que hoje funcionam.
-- ============================================================

alter table public.crm_settings
  add column if not exists meta_page_id text;

comment on column public.crm_settings.meta_page_id is
  'ID da Página do Facebook que veicula os anúncios Click-to-WhatsApp. '
  'Obrigatório para atribuir a conversão ao anúncio: a Meta valida que o '
  'ctwa_clid foi gerado por esta Página.';

-- ------------------------------------------------------------
-- RPCs recriadas para incluir o novo campo.
--
-- DROP antes de CREATE, não `create or replace`: crm_settings_get muda o
-- tipo de retorno (replace não permite) e crm_settings_save ganha um
-- parâmetro. Em Postgres, aridade diferente é uma função DIFERENTE — sem
-- o drop ficariam as duas versões e a chamada por nome viraria ambígua
-- ("function is not unique").
-- ------------------------------------------------------------

drop function if exists public.crm_settings_get();

create function public.crm_settings_get()
returns table (
  meta_pixel_id text,
  has_token boolean,
  meta_test_event_code text,
  meta_page_id text
)
language sql stable security definer set search_path = public as $$
  select s.meta_pixel_id,
         coalesce(s.meta_access_token, '') <> '',
         s.meta_test_event_code,
         s.meta_page_id
  from public.crm_settings s
  where s.organization_id = public.current_org_id();
$$;

drop function if exists public.crm_settings_save(text, text, text);

-- Mantém a permissão de 019 (admin + crm_only) e a regra do token:
-- p_token nulo preserva o atual; '' explícito apaga.
create function public.crm_settings_save(
  p_pixel text,
  p_token text default null,
  p_test_code text default null,
  p_page text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() not in ('admin', 'crm_only') then
    raise exception 'Sem permissão para alterar as configurações do CRM';
  end if;

  insert into public.crm_settings (
    organization_id, meta_pixel_id, meta_access_token,
    meta_test_event_code, meta_page_id, updated_at
  )
  values (
    v_org, nullif(p_pixel, ''), nullif(p_token, ''),
    nullif(p_test_code, ''), nullif(p_page, ''), now()
  )
  on conflict (organization_id) do update set
    meta_pixel_id = nullif(excluded.meta_pixel_id, ''),
    -- Em ON CONFLICT a linha existente é referenciada pelo nome da tabela,
    -- sem qualificar o schema.
    meta_access_token = case
      when p_token is null then crm_settings.meta_access_token
      else nullif(p_token, '')
    end,
    meta_test_event_code = nullif(excluded.meta_test_event_code, ''),
    meta_page_id = nullif(excluded.meta_page_id, ''),
    updated_at = now();
end;
$$;
