import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, Plus, Users, ChevronLeft, ChevronRight, Filter, Download, MessageCirclePlus } from 'lucide-react'
import { useCan } from '@/store/authStore'
import { useConversaStore } from '@/store/conversaStore'
import {
  crmService, formatBRL, DEFAULT_PAGE_SIZE,
  type ContactSort, type ContactFilters, type ChannelCount, type OrigemCount,
} from '@/services/crmService'
import { Loader, EmptyState } from '@/components/ui'
import { useDebounced } from '@/hooks/useDebounced'
import { toast } from '@/store/toastStore'
import { ContactDrawer } from './ContactDrawer'
import { toCSV, csvMoney, downloadCSV } from '@/lib/csv'
import { formatSP } from '@/lib/datetime'
import type { CrmContact, CrmStage } from '@/types'

/** Valor do seletor de Origem para "campo vazio" — não colide com origem real. */
const NO_ORIGEM = '__none__'

const SORT_LABEL: Record<ContactSort, string> = {
  name: 'Nome (A–Z)',
  recent: 'Mais recentes',
  value: 'Maior valor',
  stage_changed: 'Movimentação recente',
}

export function ContactsTable({ stages, onChanged }: {
  stages: CrmStage[]
  onChanged: () => void
}) {
  const can = useCan()
  // Iniciar conversa (126): para quem atende.
  const podeConversar = can('atendimento.ver') || can('atendimento.ver_todas')
  const pedirConversa = useConversaStore((st) => st.pedir)
  const [rows, setRows] = useState<CrmContact[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<ContactSort>('name')
  const [stageFilter, setStageFilter] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  // '' = todas; NO_ORIGEM = campo vazio, a lista de trabalho (Relatórios
  // mostra o resumo; aqui dá para abrir e preencher); outro = aquela origem.
  const [origemFilter, setOrigemFilter] = useState('')
  const noOrigem = origemFilter === NO_ORIGEM
  const [channels, setChannels] = useState<ChannelCount[]>([])
  const [origens, setOrigens] = useState<OrigemCount[]>([])
  const [showFilters, setShowFilters] = useState(false)

  // null = fechado; undefined = aberto para criar; objeto = editando
  const [editing, setEditing] = useState<CrmContact | null | undefined>(null)
  // 0 = parado. Qualquer outro valor é a contagem já baixada, que o botão
  // mostra: numa base grande a exportação leva alguns segundos e um botão
  // mudo parece travado.
  const [exportando, setExportando] = useState(0)

  /**
   * Contatos marcados para exportar.
   *
   * Guarda a LINHA inteira, não só o id, por dois motivos. A tabela pagina, e
   * marcar na página 1 para exportar na página 3 exige ter os dados de quem
   * saiu da tela. E, tendo a linha, a exportação da seleção não faz consulta
   * nenhuma — o CSV sai na hora, sem esperar a rede.
   *
   * A seleção SOBREVIVE a troca de filtro e de página de propósito: é
   * trabalho manual do usuário, e apagá-la porque ele foi procurar mais um
   * contato seria perder o que ele já tinha feito. Quem limpa é o botão.
   */
  const [selecionados, setSelecionados] = useState<Map<string, CrmContact>>(new Map())

  const debouncedSearch = useDebounced(search)

  const conversionStage = stages.find((s) => s.is_conversion)

  /**
   * Os filtros da tela, num objeto só para a lista, a soma e a exportação
   * nunca divergirem.
   *
   * "CONVERTIDO" AQUI É QUEM COMPROU. A coluna de conversão do kanban só tem
   * quem está nela agora — o cliente que voltou para Remarketing ou foi
   * marcado como Perdido depois de comprar sai dela, e a lista de contatos
   * dizia que ele não estava convertido. Nesta tela, escolher a etapa de
   * conversão traz todos com venda (sales_count > 0), de qualquer coluna.
   * É só esta lista: o kanban, os relatórios e o filtro de etapa de qualquer
   * outro lugar continuam lendo stage_id.
   */
  const filters = useMemo<ContactFilters>(() => {
    const convertido = !!conversionStage && stageFilter === conversionStage.id
    return {
      search: debouncedSearch,
      stageId: stageFilter && stageFilter !== '__none__' && !convertido ? stageFilter : undefined,
      outOfFunnel: stageFilter === '__none__',
      channel: channelFilter || undefined,
      noOrigem: noOrigem || undefined,
      origem: origemFilter && !noOrigem ? origemFilter : undefined,
      sales: convertido ? 'with' : undefined,
      sort,
    }
  }, [debouncedSearch, stageFilter, conversionStage, channelFilter, origemFilter, noOrigem, sort])

  // `atual` descarta a resposta de uma busca já substituída: sem isso, uma
  // resposta lenta e antiga chegava depois da nova e sobrescrevia a lista.
  const reqId = useRef(0)
  const refresh = useCallback(() => {
    const id = ++reqId.current
    setRows(null)
    crmService.listContacts({ ...filters, page })
      .then(({ rows: data, total: count }) => {
        if (id !== reqId.current) return
        setRows(data)
        setTotal(count)
      })
      .catch((err) => {
        if (id !== reqId.current) return
        // PostgrestError não é instância de Error: sem ler .message o toast
        // sempre caía no texto genérico e escondia a causa real.
        console.error('listContacts', err)
        const msg = (err as { message?: string } | null)?.message
        toast.error(msg ? `Falha ao carregar contatos: ${msg}` : 'Falha ao carregar contatos')
        setRows([])
      })
  }, [filters, page])

  useEffect(refresh, [refresh])

  // Lista de canais para o seletor. Recarrega uma vez e após salvar um
  // contato (novo canal pode ter surgido) — não a cada tecla/página.
  const [listsVersion, setListsVersion] = useState(0)
  useEffect(() => {
    crmService.listChannels().then(setChannels).catch(() => setChannels([]))
    crmService.listOrigens().then(setOrigens).catch(() => setOrigens([]))
  }, [listsVersion])

  // Qualquer mudança de filtro volta para a primeira página, senão o usuário
  // fica numa página que não existe mais no novo resultado.
  useEffect(() => { setPage(0) }, [debouncedSearch, stageFilter, channelFilter, origemFilter, sort])

  const activeFilters = (stageFilter ? 1 : 0) + (channelFilter ? 1 : 0) + (origemFilter ? 1 : 0)
  const filtering = !!debouncedSearch.trim() || activeFilters > 0

  // Quanto o filtro vendeu, somado no total de vendas de cada contato. Não
  // depende da página: soma todos os que casam. Só com filtro ou busca — a
  // base inteira já está nos relatórios. `atual` descarta a resposta de um
  // filtro que já foi trocado, para o número não piscar o valor antigo.
  const [salesSum, setSalesSum] = useState<number | null>(null)
  useEffect(() => {
    setSalesSum(null)
    if (!filtering) return
    let atual = true
    crmService.sumContactsSales(filters)
      .then((cents) => { if (atual) setSalesSum(cents) })
      .catch(() => { if (atual) setSalesSum(null) })
    return () => { atual = false }
  }, [filters, filtering])

  const stageById = (id: string | null) => (id ? stages.find((s) => s.id === id) : undefined)
  const pageCount = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE))

  const marcados = selecionados.size
  const naPagina = rows ?? []
  const todosDaPagina = naPagina.length > 0 && naPagina.every((c) => selecionados.has(c.id))
  const algunsDaPagina = naPagina.some((c) => selecionados.has(c.id))

  function alternar(c: CrmContact) {
    setSelecionados((atual) => {
      const proximo = new Map(atual)
      if (proximo.has(c.id)) proximo.delete(c.id)
      else proximo.set(c.id, c)
      return proximo
    })
  }

  /** A caixa do cabeçalho marca ou desmarca a PÁGINA, nunca a base inteira. */
  function alternarPagina() {
    setSelecionados((atual) => {
      const proximo = new Map(atual)
      if (todosDaPagina) naPagina.forEach((c) => proximo.delete(c.id))
      else naPagina.forEach((c) => proximo.set(c.id, c))
      return proximo
    })
  }

  /** Monta e baixa o arquivo. Uma função só, para os dois caminhos abaixo
      produzirem exatamente as mesmas colunas. */
  function baixar(contatos: CrmContact[]) {
    const csv = toCSV(
      [
        'Nome', 'Telefone', 'E-mail', 'Etapa', 'Canal', 'Origem', 'Etiquetas',
        'Total em vendas', 'Nº de vendas',
        'ID da conversa', 'Criado em', 'Última mudança de etapa',
      ],
      contatos.map((c) => [
        c.name,
        c.phone ?? '',
        c.email ?? '',
        stageById(c.stage_id)?.name ?? 'Fora do funil',
        c.channel ?? '',
        c.origem ?? '',
        // Ponto e vírgula é o separador do arquivo; dentro da célula as
        // etiquetas vão separadas por vírgula.
        (c.tags ?? []).join(', '),
        csvMoney(c.sales_total_cents),
        c.sales_count,
        c.conversation_id ?? '',
        formatSP(c.created_at),
        formatSP(c.stage_changed_at),
      ]),
    )
    // Data no nome para não sobrescrever a exportação da semana passada
    // na pasta de downloads.
    downloadCSV(`contatos-${new Date().toISOString().slice(0, 10)}.csv`, csv)
    toast.success(`${contatos.length} contato(s) exportado(s)`)
  }

  /**
   * Dois caminhos, e o que decide é haver seleção.
   *
   * COM CAIXAS MARCADAS exporta exatamente essas, na ordem em que foram
   * marcadas, sem consultar nada — as linhas já estão na mão.
   *
   * SEM NENHUMA MARCADA continua exportando TUDO o que casa com os filtros
   * atuais, não a página à vista. É a expectativa de quem clica: os filtros
   * estão na tela, a paginação é detalhe de navegação. O service pagina por
   * baixo (o PostgREST corta em 1000 linhas) para o arquivo não sair
   * truncado em silêncio.
   *
   * Marcar nada continuar significando "tudo" não é descuido: é o
   * comportamento que já existia, e é ele que atende o caso de exportar uma
   * base de milhares, que nenhuma caixa de seleção resolveria.
   */
  async function handleExport() {
    if (marcados > 0) {
      baixar([...selecionados.values()])
      return
    }

    setExportando(1)
    try {
      // Os mesmos filtros e a mesma ordenação da tela: o arquivo sai com o
      // que está à vista, na ordem em que está.
      const contatos = await crmService.exportContacts(filters, setExportando)

      if (!contatos.length) {
        toast.error('Nenhum contato para exportar com os filtros atuais.')
        return
      }

      baixar(contatos)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao exportar')
    } finally {
      setExportando(0)
    }
  }

  function handleSaved() {
    refresh()
    setListsVersion((v) => v + 1)
    onChanged()
  }

  return (
    <div className="crm-panel crm-contacts">
      <div className="crm-toolbar">
        {/* crm-search-block: o input estica com a barra em vez dos 190px
            fixos que a busca do kanban usa. */}
        <div className="crm-search crm-search-block">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, email ou telefone…"
          />
          <Search size={15} />
        </div>

        <button
          className={`btn btn-ghost${showFilters || activeFilters ? ' btn-active' : ''}`}
          onClick={() => setShowFilters((v) => !v)}
        >
          <Filter size={15} /> Filtros
          {activeFilters > 0 && <span className="filter-count">{activeFilters}</span>}
        </button>

        <select className="input crm-sort" value={sort} onChange={(e) => setSort(e.target.value as ContactSort)}>
          {(Object.keys(SORT_LABEL) as ContactSort[]).map((k) => (
            <option key={k} value={k}>{SORT_LABEL[k]}</option>
          ))}
        </select>

        <button
          className={`btn btn-ghost${marcados > 0 ? ' btn-active' : ''}`}
          onClick={handleExport}
          disabled={exportando > 0}
          title={marcados > 0
            ? 'Baixa apenas os contatos marcados'
            : 'Baixa todos os contatos que casam com os filtros atuais, não só esta página'}
        >
          <Download size={15} />
          {/* O rótulo diz o que o clique vai fazer. Sem isso, "Exportar CSV"
              com 12 caixas marcadas é ambíguo justamente onde o engano custa
              caro: um arquivo com a base inteira em vez dos 12. */}
          {exportando > 0
            ? `Exportando… ${exportando}`
            : marcados > 0
              ? `Exportar ${marcados} selecionado${marcados === 1 ? '' : 's'}`
              : 'Exportar CSV'}
        </button>

        <button className="btn btn-primary" onClick={() => setEditing(undefined)}>
          <Plus size={15} /> Novo contato
        </button>
      </div>

      {showFilters && (
        <div className="crm-filters">
          <div className="field">
            <label>Etapa</label>
            <select className="input" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
              <option value="">Todas as etapas</option>
              <option value="__none__">Fora do funil</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.is_conversion ? `${s.name} (todos com venda)` : s.name}
                </option>
              ))}
            </select>
          </div>
          {channels.length > 0 && (
            <div className="field">
              <label>Canal</label>
              <select className="input" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
                <option value="">Todos os canais</option>
                {channels.map((c) => (
                  <option key={c.channel} value={c.channel}>
                    {c.channel} ({c.contact_count})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label>Origem</label>
            <select className="input" value={origemFilter} onChange={(e) => setOrigemFilter(e.target.value)}>
              <option value="">Todas as origens</option>
              <option value={NO_ORIGEM}>Sem origem</option>
              {origens.map((o) => (
                <option key={o.origem} value={o.origem}>
                  {o.origem} ({o.contact_count})
                </option>
              ))}
            </select>
          </div>
          {activeFilters > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setStageFilter(''); setChannelFilter(''); setOrigemFilter('') }}
            >
              Limpar filtros
            </button>
          )}
        </div>
      )}

      {/* Fica FORA do bloco da tabela: filtrando até não sobrar ninguém, a
          seleção continua existindo, e some-la da tela deixaria o usuário
          exportando 12 contatos sem enxergar nenhum. */}
      {marcados > 0 && (
        <div className="crm-selecao">
          <span>
            <strong>{marcados}</strong> contato{marcados === 1 ? '' : 's'} marcado{marcados === 1 ? '' : 's'}
          </span>
          <span className="text-muted">
            a seleção atravessa páginas e filtros
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setSelecionados(new Map())}>
            Limpar seleção
          </button>
        </div>
      )}

      {/* O total que casa com a busca e os filtros, não só a página à vista —
          é o número que se procura ao combinar origem, canal e etapa. */}
      {rows !== null && filtering && (
        <div className="text-secondary" style={{ fontSize: 13, margin: '0 0 10px' }}>
          <strong>{total.toLocaleString('pt-BR')}</strong>{' '}
          contato{total === 1 ? '' : 's'} encontrado{total === 1 ? '' : 's'}
          {activeFilters > 0 && ` com ${activeFilters === 1 ? 'o filtro' : `os ${activeFilters} filtros`}`}
          {debouncedSearch.trim() && `${activeFilters > 0 ? ' e' : ' com'} a busca`}
          {' · '}
          {/* Soma do total de vendas de cada contato, recompras incluídas.
              É o bruto: venda reembolsada continua contando, como no
              faturamento do relatório (101). */}
          <span title="Soma das vendas desses contatos, recompras incluídas. Vendas reembolsadas continuam somando, como no faturamento bruto.">
            {salesSum === null ? 'somando vendas…' : <><strong>{formatBRL(salesSum)}</strong> em vendas</>}
          </span>
        </div>
      )}

      {rows === null ? (
        <Loader />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users />}
          text={search || activeFilters
            ? 'Nenhum contato encontrado com esses filtros.'
            : 'Nenhum contato ainda. Crie o primeiro.'}
        />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="col-check">
                    {/* Marca a PÁGINA, não a base. Com 3.000 contatos e 50 na
                        tela, uma caixa que marcasse tudo prometeria o que a
                        memória não sustenta — e para "tudo" já existe o botão
                        de exportar sem seleção nenhuma. */}
                    <input
                      type="checkbox"
                      checked={todosDaPagina}
                      ref={(el) => {
                        // Traço em vez de check quando a página está pela
                        // metade: sem isso a caixa aparece vazia e sugere que
                        // nada ali embaixo está marcado.
                        if (el) el.indeterminate = algunsDaPagina && !todosDaPagina
                      }}
                      onChange={alternarPagina}
                      aria-label={todosDaPagina ? 'Desmarcar esta página' : 'Marcar esta página'}
                    />
                  </th>
                  <th>Nome</th>
                  <th>Email</th>
                  <th>Telefone</th>
                  <th>Canal</th>
                  <th>Etapa</th>
                  <th style={{ textAlign: 'right' }}>Vendas</th>
                  {podeConversar && <th aria-label="Conversar" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const stage = stageById(c.stage_id)
                  // Busca de 4 dígitos: quem termina neles vem na frente
                  // (listContactsFimTelefone) e ganha destaque.
                  const fimMatch = /^\d{4}$/.test(debouncedSearch.trim())
                    && !!c.phone && c.phone.endsWith(debouncedSearch.trim())
                  return (
                    <tr
                      key={c.id}
                      className={`row-clickable${selecionados.has(c.id) ? ' row-selected' : ''}`}
                      onClick={() => setEditing(c)}
                    >
                      {/* stopPropagation: a linha inteira abre o contato, e
                          sem isto marcar a caixa abriria o painel por cima. */}
                      <td className="col-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selecionados.has(c.id)}
                          onChange={() => alternar(c)}
                          aria-label={`Selecionar ${c.name}`}
                        />
                      </td>
                      <td><strong>{c.name}</strong></td>
                      <td className="text-secondary">{c.email || '—'}</td>
                      <td className="text-secondary mono">
                        {fimMatch && c.phone ? (
                          <>
                            {c.phone.slice(0, -4)}
                            <mark className="fim-match">{c.phone.slice(-4)}</mark>
                          </>
                        ) : (c.phone || '—')}
                      </td>
                      <td className="text-secondary" style={{ fontSize: 12 }}>
                        {c.channel || '—'}
                      </td>
                      <td>
                        {stage ? (
                          <span className="stage-pill" style={{ '--stage': stage.color } as React.CSSProperties}>
                            <span className="stage-dot" /> {stage.name}
                          </span>
                        ) : (
                          <span className="badge badge-gray" >Fora do funil</span>
                        )}
                      </td>
                      {/* Quantas vendas e quanto somam, recompras incluídas. */}
                      <td style={{ textAlign: 'right', fontSize: 12 }} className="text-secondary">
                        {c.sales_count > 0
                          ? `${c.sales_count} · ${formatBRL(c.sales_total_cents)}`
                          : '—'}
                      </td>
                      {podeConversar && (
                        <td className="col-acao" onClick={(e) => e.stopPropagation()}>
                          {c.phone && (
                            <button
                              className="icon-btn"
                              title="Conversar no WhatsApp"
                              aria-label={`Conversar com ${c.name} no WhatsApp`}
                              onClick={() => pedirConversa({ id: c.id, name: c.name, phone: c.phone })}
                            >
                              <MessageCirclePlus size={15} />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="crm-pagination">
            <span className="text-muted" style={{ fontSize: 12 }}>
              {total} contato(s) · página {page + 1} de {pageCount}
            </span>
            <div className="flex" style={{ gap: 6 }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                <ChevronLeft size={15} /> Anterior
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
              >
                Próxima <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </>
      )}

      {editing !== null && (
        <ContactDrawer
          contact={editing ?? null}
          stages={stages}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
