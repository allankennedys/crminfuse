/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  /** Qual app esta build serve: "groups" (padrão) ou "crm". */
  readonly VITE_APP?: 'groups' | 'crm'
  /** URL do domínio do CRM, usada nos links entre os dois apps. */
  readonly VITE_CRM_URL?: string
  /** URL do domínio da gestão de grupos, usada nos links entre os dois apps. */
  readonly VITE_GROUPS_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
