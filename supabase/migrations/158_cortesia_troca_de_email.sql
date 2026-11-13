-- Cortesia: sai klenofelipe@gmail.com, entra contato@agenciaalpi.com.br.
delete from public.cortesias_email where email = 'klenofelipe@gmail.com';
insert into public.cortesias_email (email) values ('contato@agenciaalpi.com.br') on conflict do nothing;

-- Se a conta já existir, libera agora.
update public.subscriptions s set updated_at = now()
where exists (select 1 from public.users u where u.organization_id = s.organization_id and lower(u.email) = 'contato@agenciaalpi.com.br');
