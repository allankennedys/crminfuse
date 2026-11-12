import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Users, Smartphone, MessageSquare,
  CalendarClock, ScrollText, Settings, LogOut, Menu, X,
} from 'lucide-react'
import { useAuthStore, useCan } from '@/store/authStore'
import { supabase } from '@/lib/supabase'

/**
 * `perm` é a permissão que libera o item (055). Esconder o link é espelho
 * da RLS, não a regra — quem entrar pela URL direto vê a tela carregar
 * vazia, porque o banco recusa a consulta.
 *
 * `sistema: true` separa a seção "Sistema" da "Operação". Antes o corte era
 * por índice (slice(0,7)/slice(7)), o que quebrava assim que a lista passou
 * a ser filtrada por permissão.
 */
const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: 'painel.dashboard.ver' },
  { to: '/groups', label: 'Grupos', icon: Users, perm: 'painel.grupos.ver' },
  { to: '/sessions', label: 'Números', icon: Smartphone, perm: 'painel.numeros.ver' },
  { to: '/messages', label: 'Mensagens', icon: MessageSquare, perm: 'painel.mensagens.ver' },
  { to: '/schedules', label: 'Agendamentos', icon: CalendarClock, perm: 'painel.agendamentos.ver' },
  { to: '/logs', label: 'Histórico', icon: ScrollText, perm: 'painel.historico.ver' },
  { to: '/settings', label: 'Configurações', icon: Settings, perm: 'painel.config.ver', sistema: true },
]

const TITLES: Record<string, string> = {
  '/dashboard': 'Visão geral',
  '/groups': 'Gerenciamento de grupos',
  '/sessions': 'Números WhatsApp',
  '/messages': 'Envio de mensagens',
  '/schedules': 'Agendamentos',
  '/logs': 'Histórico de envios',
  '/settings': 'Configurações',
}

export function Layout() {
  const { profile, signOut } = useAuthStore()
  const can = useCan()
  const navPermitido = NAV.filter((n) => can(n.perm))
  const navOperacao = navPermitido.filter((n) => !n.sistema)
  const navSistema = navPermitido.filter((n) => n.sistema)
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [workerOn, setWorkerOn] = useState(false)

  // Título da aba do navegador para a área de gestão.
  useEffect(() => {
    document.title = 'Infuse - Gestão de Grupos'
  }, [])

  // Fecha o menu mobile ao navegar
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  // Online = worker do servidor rodou nos últimos 2 minutos
  useEffect(() => {
    const check = async () => {
      const { data } = await supabase
        .from('worker_status')
        .select('last_run_at')
        .eq('id', 1)
        .maybeSingle()
      const last = data?.last_run_at ? new Date(data.last_run_at).getTime() : 0
      setWorkerOn(Date.now() - last < 120_000)
    }
    check()
    const timer = setInterval(check, 30_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="app-shell">
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <img src="/logo.png" alt="Infuse" className="brand-logo" />
        </div>

        {navOperacao.length > 0 && <div className="nav-section-label">Operação</div>}
        {navOperacao.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Icon /> {label}
          </NavLink>
        ))}


        {navSistema.length > 0 && <div className="nav-section-label">Sistema</div>}
        {navSistema.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Icon /> {label}
          </NavLink>
        ))}

        <div className="sidebar-footer">
          <div className="nav-item" style={{ cursor: 'default' }}>
            <span className={`badge ${workerOn ? 'badge-green' : 'badge-gray'}`}>
              <span className="dot" /> {workerOn ? 'Online' : 'Offline'}
            </span>
          </div>
          <button className="nav-item" style={{ width: '100%', background: 'none', border: 'none', fontSize: 14 }} onClick={signOut}>
            <LogOut /> Sair
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="flex">
            <button className="menu-toggle" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
              {menuOpen ? <X size={19} /> : <Menu size={19} />}
            </button>
            <span className="topbar-title">{TITLES[location.pathname] ?? 'Infuse Groups'}</span>
          </div>
          <div className="flex">
            <span className="badge badge-gray">{profile?.role}</span>
            <span className="text-secondary" style={{ fontSize: 13 }}>
              {profile?.full_name ?? profile?.email}
            </span>
          </div>
        </header>
        <main className="page-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
