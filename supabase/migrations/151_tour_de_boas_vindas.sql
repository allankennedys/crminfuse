-- ============================================================
-- Tour de boas-vindas: aparece no PRIMEIRO acesso de cada usuário (não por
-- aparelho). tour_done_at guarda quando ele foi concluído ou pulado; quem já
-- tem a data não vê de novo (a tela deixa rever pelo botão, sem mexer aqui).
-- ============================================================

alter table public.users add column if not exists tour_done_at timestamptz;

-- O próprio usuário marca o dele (a RLS de users não deixa escrever à vontade).
create or replace function public.tour_complete()
returns void
language sql security definer set search_path = public as $$
  update public.users set tour_done_at = now() where id = auth.uid() and tour_done_at is null;
$$;
revoke all on function public.tour_complete() from public, anon;
grant execute on function public.tour_complete() to authenticated;
