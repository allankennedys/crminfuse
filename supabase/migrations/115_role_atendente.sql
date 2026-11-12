-- ============================================================
-- Cargo "atendente" — quem responde as conversas de WhatsApp
--
-- Arquivo separado de propósito, como a 054: o valor novo de um enum só pode
-- ser usado depois de commitado. A 116 (atendimento) depende dele.
--
-- O atendente só enxerga as conversas atribuídas a ele (116). Não vê funil,
-- contatos, relatórios nem o painel de grupos.
-- ============================================================

alter type public.user_role add value if not exists 'atendente';
