-- ============================================================
-- meta_page_id sai do alcance da tela
--
-- A Página dos anúncios é configuração rara e sensível: define a quem a
-- Meta credita a receita. Fica fora da UI, ajustada só por SQL.
--
-- Por que mexer na RPC e não apenas remover o campo do front: a versão de
-- 026 recebe p_page e faz `meta_page_id = nullif(excluded.meta_page_id, '')`
-- no ON CONFLICT. Com o front chamando sem esse argumento, p_page chega
-- nulo e o UPDATE APAGARIA a Página a cada salvamento de pixel ou token —
-- a atribuição dos anúncios morreria em silêncio, sem erro nenhum.
--
-- O token não sofre disso porque tem tratamento explícito (nulo = manter).
-- Aqui a solução é mais simples: a RPC volta a não conhecer meta_page_id,
-- então o UPDATE não menciona a coluna e ela fica intocada.
--
-- crm_settings_get segue devolvendo meta_page_id — ler é inofensivo e
-- serve para exibir o valor em tela algum dia, se fizer sentido.
-- ============================================================

drop function if exists public.crm_settings_save(text, text, text, text);

create function public.crm_settings_save(
  p_pixel text,
  p_token text default null,
  p_test_code text default null
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
    meta_test_event_code, updated_at
  )
  values (
    v_org, nullif(p_pixel, ''), nullif(p_token, ''),
    nullif(p_test_code, ''), now()
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
    -- meta_page_id ausente de propósito: ver cabeçalho.
    updated_at = now();
end;
$$;
