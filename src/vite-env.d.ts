/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Endereço da API (https://api.infusesoftware.com). */
  readonly VITE_API_URL: string
  /** Chave pública da API (feita para ficar no navegador; o acesso é decidido pelo login). */
  readonly VITE_API_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
