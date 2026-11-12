-- ============================================================
-- Papel "Apenas CRM" (crm_only)
--
-- Usuário que só enxerga o módulo CRM: ao logar cai direto no /crm e não
-- alcança o painel (dashboard, grupos, envios, etc.). Dentro do CRM opera
-- como um operador — cria, edita e move contatos.
--
-- ATENÇÃO: adicionar valor a um enum precisa estar COMMITADO antes de ser
-- usado. Por isso o novo valor entra AQUI, sozinho, e as políticas que o
-- referenciam ficam na migration 018 (transação seguinte). Juntar as duas
-- no mesmo arquivo dá "unsafe use of new value 'crm_only'".
-- ============================================================

alter type public.user_role add value if not exists 'crm_only';
