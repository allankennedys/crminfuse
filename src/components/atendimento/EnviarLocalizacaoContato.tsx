import { useState } from 'react'
import { LocateFixed } from 'lucide-react'
import { Modal } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { atendimentoService } from '@/services/atendimentoService'
import type { WaMessage } from '@/types'

/** "-23,5505" / "-23.5505" → número; NaN se não for. */
const num = (t: string) => Number(t.trim().replace(',', '.'))

/** Enviar um ponto no mapa (144). Aceita digitar ou usar a localização do aparelho. */
export function EnviarLocalizacao({ conversationId, onSent, onClose }: {
  conversationId: string
  onSent: (m: WaMessage) => void
  onClose: () => void
}) {
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [locating, setLocating] = useState(false)

  const valida = Number.isFinite(num(lat)) && lat.trim() !== '' && Number.isFinite(num(lng)) && lng.trim() !== ''
    && Math.abs(num(lat)) <= 90 && Math.abs(num(lng)) <= 180

  const usarMinha = () => {
    if (!navigator.geolocation) return toast.error('Este navegador não informa a localização.')
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6))
        setLng(p.coords.longitude.toFixed(6))
        setLocating(false)
      },
      () => {
        setLocating(false)
        toast.error('Não consegui pegar a localização. Permita no navegador ou digite as coordenadas.')
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  const enviar = async () => {
    if (!valida) return
    setBusy(true)
    try {
      const m = await atendimentoService.sendLocation(conversationId, {
        latitude: num(lat), longitude: num(lng), name: name.trim() || undefined, address: address.trim() || undefined,
      })
      onSent(m)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível enviar a localização')
      setBusy(false)
    }
  }

  return (
    <Modal title="Enviar localização" onClose={onClose} variant="dialog">
      <button type="button" className="btn btn-ghost btn-sm" onClick={usarMinha} disabled={locating} style={{ marginBottom: 12 }}>
        <LocateFixed size={14} /> {locating ? 'Buscando…' : 'Usar minha localização'}
      </button>
      <div className="at-task-when" style={{ marginBottom: 10 }}>
        <div className="field" style={{ flex: 1, margin: 0 }}>
          <label htmlFor="loc-lat">Latitude</label>
          <input id="loc-lat" className="input" inputMode="decimal" placeholder="-23.5505" value={lat} onChange={(e) => setLat(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1, margin: 0 }}>
          <label htmlFor="loc-lng">Longitude</label>
          <input id="loc-lng" className="input" inputMode="decimal" placeholder="-46.6333" value={lng} onChange={(e) => setLng(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="loc-nome">Nome do local (opcional)</label>
        <input id="loc-nome" className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Nossa loja" />
      </div>
      <div className="field">
        <label htmlFor="loc-end">Endereço (opcional)</label>
        <input id="loc-end" className="input" maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <div className="flex" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancelar</button>
        <button className="btn btn-primary" onClick={enviar} disabled={busy || !valida}>
          {busy ? <span className="spinner" /> : 'Enviar'}
        </button>
      </div>
    </Modal>
  )
}

/** Enviar um cartão de contato (144): nome + telefone. */
export function EnviarContato({ conversationId, onSent, onClose }: {
  conversationId: string
  onSent: (m: WaMessage) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const digitos = phone.replace(/\D/g, '')
  const valido = name.trim().length > 0 && digitos.length >= 10 && digitos.length <= 15

  const enviar = async () => {
    if (!valido) return
    setBusy(true)
    try {
      const m = await atendimentoService.sendContact(conversationId, name.trim(), phone)
      onSent(m)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível enviar o contato')
      setBusy(false)
    }
  }

  return (
    <Modal title="Enviar contato" onClose={onClose} variant="dialog">
      <div className="field">
        <label htmlFor="ct-nome">Nome</label>
        <input id="ct-nome" className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="ct-tel">Telefone (com DDD)</label>
        <input id="ct-tel" className="input" inputMode="tel" placeholder="(11) 99999-9999" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div className="flex" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancelar</button>
        <button className="btn btn-primary" onClick={enviar} disabled={busy || !valido}>
          {busy ? <span className="spinner" /> : 'Enviar'}
        </button>
      </div>
    </Modal>
  )
}
