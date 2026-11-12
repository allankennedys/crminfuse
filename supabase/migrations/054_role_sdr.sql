-- ============================================================
-- crm_only vira SDR
--
-- Só o rename e o mínimo para o banco continuar de pé. As permissões
-- personalizadas por usuário vêm na 055, em execução separada.
--
-- POR QUE RENAME E NÃO "ADD VALUE + UPDATE + DROP"
--
-- `alter type ... rename value` troca o rótulo em pg_enum sem mexer no OID.
-- As linhas de public.users que hoje valem 'crm_only' passam a valer 'sdr'
-- sozinhas — nenhum UPDATE, nenhuma janela em que um usuário fique com
-- papel inválido. Adicionar um valor novo e migrar à mão daria o mesmo
-- resultado com três passos a mais e um estado intermediário quebrado.
--
-- O QUE SOBREVIVE AO RENAME SOZINHO, E O QUE NÃO
--
--   POLÍTICAS RLS  → sobrevivem. A expressão é guardada parseada, e o
--                    literal virou uma constante que aponta para o OID do
--                    valor. Renomear o rótulo não move o OID.
--   CORPOS DE FUNÇÃO → NÃO. `language sql`/`plpgsql` guardam texto, que é
--                    reparseado a cada execução. Uma função com 'crm_only'
--                    escrito dentro passa a estourar "invalid input value
--                    for enum" na primeira chamada depois do rename.
--
-- Por isso as duas funções abaixo são recriadas aqui, junto do rename: são
-- as únicas com o rótulo antigo no corpo além de crm_settings_save, que
-- muda de regra e está logo adiante.
--
-- META VIRA EXCLUSIVA DE ADMIN
--
-- Até aqui crm_only editava o Pixel, o token da Conversion API e a conta de
-- anúncios. Um SDR prospecta — não tem por que alcançar credencial de
-- integração, que é o que decide a quem a Meta credita receita e o que
-- pararia todo o envio de conversões se fosse trocado por engano.
--
-- crm_settings_get continua aberto a qualquer membro: ele nunca devolveu o
-- token, só `has_token`. Assim a tela de configurações mostra o estado para
-- quem abre, e o botão de salvar é que fica fora de alcance.
-- ============================================================

alter type public.user_role rename value 'crm_only' to 'sdr';

-- ------------------------------------------------------------
-- Funções com o rótulo antigo no corpo (022)
--
-- Recriadas com 'sdr'. A regra é a mesma de antes — quem mexia em etapa
-- continua mexendo. Quem troca isso por permissão é a 055.
-- ------------------------------------------------------------
create or replace function public.crm_reorder_stages(p_ids uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() not in ('admin', 'operator', 'sdr') then
    raise exception 'Sem permissão para reordenar etapas';
  end if;

  update public.crm_stages s
  set position = idx.ord - 1
  from unnest(p_ids) with ordinality as idx(id, ord)
  where s.id = idx.id and s.organization_id = v_org;
end;
$$;

create or replace function public.crm_delete_stage(
  p_id uuid,
  p_move_to uuid default null,
  p_unassign boolean default false
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_count int;
begin
  if public.current_user_role() not in ('admin', 'operator', 'sdr') then
    raise exception 'Sem permissão para excluir etapas';
  end if;

  if not exists (select 1 from public.crm_stages where id = p_id and organization_id = v_org) then
    raise exception 'Etapa não encontrada';
  end if;

  select count(*) into v_count from public.crm_contacts
  where stage_id = p_id and organization_id = v_org;

  if v_count > 0 then
    if p_unassign then
      -- Tira do funil: continuam existindo na página de Contatos.
      update public.crm_contacts set stage_id = null
      where stage_id = p_id and organization_id = v_org;
    else
      if p_move_to is null then
        raise exception 'A etapa tem % contato(s). Escolha para onde movê-los antes de excluir.', v_count;
      end if;
      if p_move_to = p_id then
        raise exception 'Escolha uma etapa diferente para receber os contatos.';
      end if;
      if not exists (select 1 from public.crm_stages where id = p_move_to and organization_id = v_org) then
        raise exception 'Etapa de destino não encontrada';
      end if;
      update public.crm_contacts set stage_id = p_move_to
      where stage_id = p_id and organization_id = v_org;
    end if;
  end if;

  delete from public.crm_stages where id = p_id and organization_id = v_org;
end;
$$;

-- ------------------------------------------------------------
-- Configurações da Meta: só admin
--
-- Mesma assinatura de 5 argumentos da 052 (pixel, token, código de teste,
-- conta de anúncios, token de leitura) e as mesmas regras de nulo:
-- null = não mexe, '' = apaga. Muda só quem pode chamar.
--
-- O DROP abaixo não é decorativo. A versão de 3 argumentos (029) tem
-- 'crm_only' escrito no corpo e viraria uma função quebrada no instante do
-- rename — e como aridade diferente é FUNÇÃO diferente no Postgres, ela
-- conviveria com a de 5. O front chama por nome de argumento; com as duas
-- vivas, uma chamada de 3 argumentos casa com ambas e o PostgREST responde
-- "function is not unique".
--
-- A 052 já derruba essa versão. Repetir aqui torna a 054 segura mesmo se a
-- 052 não tiver sido aplicada — `if exists` é no-op quando ela já saiu.
-- A de 4 argumentos (027) foi derrubada pela 029 e não existe mais.
-- ------------------------------------------------------------
drop function if exists public.crm_settings_save(text, text, text);

create or replace function public.crm_settings_save(
  p_pixel      text,
  p_token      text default null,
  p_test_code  text default null,
  p_ad_account text default null,
  p_ads_token  text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem alterar as credenciais da Meta';
  end if;

  insert into public.crm_settings (
    organization_id, meta_pixel_id, meta_access_token,
    meta_test_event_code, meta_ad_account_id, meta_ads_token, updated_at
  )
  values (
    v_org, nullif(p_pixel, ''), nullif(p_token, ''),
    nullif(p_test_code, ''), nullif(p_ad_account, ''), nullif(p_ads_token, ''),
    now()
  )
  on conflict (organization_id) do update set
    meta_pixel_id = nullif(excluded.meta_pixel_id, ''),
    meta_access_token = case
      when p_token is null then crm_settings.meta_access_token
      else nullif(p_token, '')
    end,
    meta_test_event_code = nullif(excluded.meta_test_event_code, ''),
    meta_ad_account_id = case
      when p_ad_account is null then crm_settings.meta_ad_account_id
      else nullif(p_ad_account, '')
    end,
    meta_ads_token = case
      when p_ads_token is null then crm_settings.meta_ads_token
      else nullif(p_ads_token, '')
    end,
    -- meta_page_id ausente de propósito: ver 029.
    updated_at = now();
end;
$$;

comment on function public.crm_settings_save(text, text, text, text, text) is
  'Credenciais da Meta (Conversion API e Marketing API). Exclusiva de admin '
  'desde a 054: SDR e operador não alcançam token nem conta de anúncios.';
