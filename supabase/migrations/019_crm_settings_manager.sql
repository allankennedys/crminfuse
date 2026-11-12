-- ============================================================
-- "Apenas CRM" pode configurar o Pixel da Meta
--
-- O gestor de CRM (crm_only) precisa configurar a Conversion API — pixel,
-- token e código de teste — sem depender de um admin. Liberamos só ESSA
-- RPC para ele. Chaves de API continuam exclusivas de admin (crm_api_key_*
-- seguem inalteradas em 013): gerar credencial de automação é outra alçada.
--
-- Roda depois de 017 (que commitou o valor 'crm_only' no enum), então o
-- uso do valor aqui é seguro.
--
-- Corpo idêntico ao de 013; muda só a checagem de papel.
-- ============================================================

create or replace function public.crm_settings_save(
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

  insert into public.crm_settings (organization_id, meta_pixel_id, meta_access_token, meta_test_event_code, updated_at)
  values (v_org, nullif(p_pixel, ''), nullif(p_token, ''), nullif(p_test_code, ''), now())
  on conflict (organization_id) do update set
    meta_pixel_id = nullif(excluded.meta_pixel_id, ''),
    -- Em ON CONFLICT a linha existente é referenciada pelo nome da tabela,
    -- sem qualificar o schema.
    meta_access_token = case
      when p_token is null then crm_settings.meta_access_token
      else nullif(p_token, '')
    end,
    meta_test_event_code = nullif(excluded.meta_test_event_code, ''),
    updated_at = now();
end;
$$;
