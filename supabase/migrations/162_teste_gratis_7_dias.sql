-- Teste grátis de 7 dias para empresas novas (configurável em Configurações → Plataforma).
-- Ao fim do teste o próprio sistema bloqueia o acesso até a assinatura do plano.
insert into public.platform_settings (key, value) values ('trial_days', '7')
on conflict (key) do update set value = excluded.value;
