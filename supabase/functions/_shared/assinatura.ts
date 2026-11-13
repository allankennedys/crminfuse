/** Acesso da organização ('total' | 'leitura' | 'bloqueado'), calculado no banco (org_acesso). */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export async function acessoDaOrganizacao(admin: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await admin.rpc('org_acesso', { p_org: orgId })
  return typeof data === 'string' ? data : 'total'
}

export const MSG_SEM_ACESSO: Record<string, string> = {
  leitura: 'Sua assinatura está em modo leitura. Regularize em Configurações → Plano e cobrança para voltar a enviar e editar.',
  bloqueado: 'Sua assinatura está suspensa. Regularize em Configurações → Plano e cobrança.',
}
