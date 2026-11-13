-- ============================================================
-- Página do Facebook dos anúncios volta para a tela (Integrações)
--
-- Sem ela, a venda de quem veio de anúncio Click-to-WhatsApp não chega à
-- Meta: o clique (ctwa_clid) só é aceito junto com a Página que veiculou o
-- anúncio (027) — e o crm-worker deixa esses eventos pendentes até ela
-- existir. Na PH a Página foi tirada da tela de propósito (029) e gravada
-- por SQL, porque era uma empresa só. Aqui cada organização é um cliente
-- com a própria Página, então o admin precisa conseguir informar.
--
-- RPC separada de crm_settings_save de propósito: aquela não conhece a
-- coluna (029), então salvar pixel/token continua sem risco de apagar a
-- Página. Esta só mexe nela.
-- ============================================================

create or replace function public.crm_settings_set_page(p_page text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid := public.current_org_id();
  v_page text := nullif(regexp_replace(coalesce(p_page, ''), '\D', '', 'g'), '');
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Só o administrador altera a Página dos anúncios';
  end if;
  if v_page is not null and length(v_page) < 6 then
    raise exception 'O ID da Página tem só números e costuma ter 15 ou 16 dígitos';
  end if;

  insert into public.crm_settings (organization_id, meta_page_id, updated_at)
  values (v_org, v_page, now())
  on conflict (organization_id) do update set
    meta_page_id = excluded.meta_page_id,
    updated_at   = now();
end;
$$;

revoke all on function public.crm_settings_set_page(text) from public, anon;
grant execute on function public.crm_settings_set_page(text) to authenticated;
