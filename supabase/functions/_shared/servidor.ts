/**
 * Segredo que o banco exige para criar usuário por e-mail (gatilho
 * bloquear_cadastro_direto, migração 159). Vai em user_metadata.servidor_key; o
 * gatilho confere e apaga. Fica em platform_settings (o app não lê).
 */
// deno-lint-ignore no-explicit-any
export async function chaveServidor(admin: any): Promise<string> {
  const { data } = await admin.from('platform_settings').select('value').eq('key', 'signup_secret').maybeSingle()
  return String(data?.value ?? '')
}
