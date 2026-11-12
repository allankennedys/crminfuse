-- ============================================================
-- Entrar na etapa de conversão volta a registrar venda
--
-- Depois da 031 o fluxo ficou de mão única: quem registra a venda é que
-- move o contato para a conversão. Só que a equipe continua convertendo do
-- jeito de sempre — arrastando o card — e por esse caminho nenhuma venda
-- nascia. Resultado: funil marcando conversão e relatório de vendas vazio.
--
-- Aqui as duas pontas voltam a se ligar, sem desfazer o fluxo novo:
--
--   • arrastar o card (ou mover pela API) cria a venda automaticamente;
--   • registrar a venda continua movendo o contato, como na 031.
--
-- O QUE IMPEDE O LAÇO
--
-- A venda só é criada se o contato NÃO TIVER NENHUMA venda. Quando foi a
-- venda que empurrou o contato para a etapa, ele já tem uma — e o gatilho
-- não faz nada. É a mesma condição que impede uma segunda venda quando o
-- contato sai da etapa e volta.
--
-- O QUE FICA DE FORA, DE PROPÓSITO
--
-- Contato que entra na conversão SEM valor não gera venda: R$ 0 entraria na
-- contagem e derrubaria o ticket médio representando nada. Se o valor for
-- preenchido depois, a venda precisa ser lançada pelo painel — o gatilho não
-- reage a edição de valor, só a mudança de etapa.
--
-- creatives fica 0 ("não informado"), como nas vendas importadas: pela etapa
-- não há de onde tirar a quantidade. Quem precisa dela lança pelo painel ou
-- pela API, que pedem o número.
-- ============================================================

create or replace function public.crm_sale_from_stage()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_converts boolean;
  v_was_conversion boolean;
begin
  -- Etapa não mudou: nada a fazer. Também é o que torna inofensivo o UPDATE
  -- que a própria trigger de vendas faz no contato.
  if tg_op = 'UPDATE' and old.stage_id is not distinct from new.stage_id then
    return null;
  end if;

  select is_conversion into v_converts
  from public.crm_stages where id = new.stage_id;

  if not coalesce(v_converts, false) then
    return null;
  end if;

  -- Veio de outra etapa que já convertia: não é conversão nova.
  if tg_op = 'UPDATE' then
    select is_conversion into v_was_conversion
    from public.crm_stages where id = old.stage_id;

    if coalesce(v_was_conversion, false) then
      return null;
    end if;
  end if;

  if coalesce(new.value_cents, 0) <= 0 then
    return null;
  end if;

  -- Já tem venda: ou foi a venda que trouxe o contato para cá (031), ou ele
  -- já comprou antes. Nos dois casos não cabe criar outra.
  if exists (select 1 from public.crm_sales where contact_id = new.id) then
    return null;
  end if;

  insert into public.crm_sales (
    organization_id, contact_id, creatives, value_cents, sold_at, note
  ) values (
    new.organization_id,
    new.id,
    0,
    new.value_cents,
    now(),
    'Criada ao entrar na etapa de conversão'
  );

  return null;
end;
$$;

-- Nome depois de crm_contacts_stage_change de propósito: triggers do mesmo
-- evento disparam em ordem alfabética, então o histórico e o evento da Meta
-- são gravados antes — lendo o value_cents que o usuário informou, não um
-- efeito colateral desta trigger.
create trigger crm_contacts_stage_sale
  after insert or update of stage_id on public.crm_contacts
  for each row execute function public.crm_sale_from_stage();

comment on function public.crm_sale_from_stage() is
  'Cria a venda do contato ao entrar na etapa de conversão, se ele ainda não '
  'tiver venda e tiver valor. Complementa o caminho inverso da 031 (venda '
  'registrada move o contato).';

-- ------------------------------------------------------------
-- ACERTO: quem converteu entre a 031 e esta migration
--
-- A importação da 031 foi um retrato único. Contato que converteu depois
-- dela, arrastando o card, ficou sem venda. Mesma regra de lá: converteu e
-- tem valor.
--
-- A trigger de sincronia fica DESLIGADA durante o insert. Ligada, ela
-- moveria esses contatos de volta para a etapa de conversão — desfazendo o
-- arquivamento da 030 e ressuscitando card antigo no funil. Os totais do
-- contato são recalculados logo abaixo, no lugar dela.
-- ------------------------------------------------------------
alter table public.crm_sales disable trigger crm_sales_sync;

insert into public.crm_sales (organization_id, contact_id, creatives, value_cents, sold_at, note)
select
  c.organization_id,
  c.id,
  0,
  c.value_cents,
  coalesce(
    (
      select min(h.created_at)
      from public.crm_stage_history h
      join public.crm_stages s on s.id = h.to_stage_id
      where h.contact_id = c.id and s.is_conversion
    ),
    c.updated_at
  ),
  'Importada da conversão já registrada'
from public.crm_contacts c
where c.value_cents > 0
  and public.crm_has_converted(c.id)
  and not exists (select 1 from public.crm_sales v where v.contact_id = c.id);

update public.crm_contacts c set
  sales_count = t.n,
  sales_total_cents = t.total
from (
  select contact_id, count(*)::int as n, sum(value_cents)::bigint as total
  from public.crm_sales
  group by contact_id
) t
where t.contact_id = c.id;

alter table public.crm_sales enable trigger crm_sales_sync;
