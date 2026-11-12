import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/lib/theme'

/** Botão de alternar claro/escuro. */
export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const theme = useTheme((s) => s.theme)
  const toggle = useTheme((s) => s.toggle)
  const label = theme === 'dark' ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'
  return (
    <button className={className} onClick={toggle} title={label} aria-label={label}>
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  )
}
