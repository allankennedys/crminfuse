import { useEffect, useState } from 'react'
import { supabase, FunctionRegion } from '@/lib/supabase'

/** Dono da plataforma? Decidido no servidor (secret OWNER_EMAIL): o e-mail dele não vai no bundle. */
export function useIsOwner(): boolean {
  const [owner, setOwner] = useState(false)
  useEffect(() => {
    let vivo = true
    supabase.functions.invoke('admin-users', { body: { action: 'whoami' }, region: FunctionRegion.EuWest3 })
      .then(({ data }) => { if (vivo) setOwner(Boolean(data?.is_owner)) })
      .catch(() => {})
    return () => { vivo = false }
  }, [])
  return owner
}
