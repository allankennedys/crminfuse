-- ============================================================
-- Bucket de mídias + políticas de acesso (Supabase Storage)
--
-- Bucket público para leitura (a Evolution API baixa a mídia
-- pela URL pública); escrita e exclusão só para admin/operator
-- da organização, restritos à pasta da própria organização.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', true, 104857600) -- 100 MB por arquivo
on conflict (id) do nothing;

-- Upload: apenas admin/operator, somente na pasta da própria org
create policy "media_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_user_role() in ('admin', 'operator')
  );

-- Exclusão: mesmas regras do upload
create policy "media_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_user_role() in ('admin', 'operator')
  );

-- Listagem/consulta autenticada: só arquivos da própria org
create policy "media_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );
