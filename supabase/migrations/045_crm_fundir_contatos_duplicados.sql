-- ============================================================
-- Junta os contatos que a 044 passou a reconhecer como o mesmo cliente
--
-- A 044 fez as duas grafias do celular (com e sem o 9 extra) apontarem para
-- o mesmo contato daqui para a frente. Ela não mexeu no que já estava
-- partido: o cliente que virou dois registros continua com o cadastro
-- dividido — de um lado a venda e a conversão, do outro o conversation_id
-- pelo qual o n8n fala com ele.
--
-- Esta migration fecha essa dívida.
--
-- QUAIS PARES ELA TOCA
--
-- Só a forma inequívoca: exatamente dois contatos com a mesma phone_key e
-- venda em apenas um dos lados. Aí não há o que decidir — quem vendeu é o
-- cliente, o outro é carcaça de importação (created_at 2025-01-01, sem
-- venda, sem evento, etapa parada).
--
-- Par em que OS DOIS lados venderam fica intocado e sai num aviso no fim.
-- Fundir ali significaria escolher qual venda é a "primeira" do cliente, e
-- é essa escolha que define o valor que já foi para a Meta. Não é decisão
-- de migration.
--
-- O QUE NÃO SE PERDE
--
-- Do descartado sobem para o sobrevivente os campos que ele não tiver:
-- conversation_id, email, origem, ctwaclid e as tags (unidas, não
-- substituídas). O ctwaclid importa mais que os outros — é o clique no
-- anúncio, e sem ele a conversão do cliente deixaria de ser atribuída.
--
-- Nome diferente nos dois lados vai para a descrição em vez de sumir: é o
-- caso de "EVOLUX" e "Sidneia", o mesmo cliente cadastrado pelo nome da
-- empresa de um lado e pelo nome pessoal do outro.
--
-- O QUE SE PERDE, DE PROPÓSITO
--
-- O histórico de etapas do descartado (crm_stage_history é cascade). São as
-- passagens de uma carcaça que nunca converteu; mantê-las no sobrevivente
-- inventaria um vaivém que não aconteceu, com datas de importação.
--
-- Canal também: fica o do sobrevivente. Quando os dois diferem (PH de um
-- lado, Pedro do outro) é porque o cliente falou com os dois números — e o
-- canal que conta é aquele por onde a venda entrou.
--
-- ORDEM DENTRO DO LAÇO
--
-- Vendas primeiro, depois o delete, depois os campos. Não é arbitrário:
-- crm_sales é cascade, então apagar antes de mover levaria junto justamente
-- a venda que motivou o merge; e o conversation_id só pode ser gravado no
-- sobrevivente depois que o descartado sumiu, senão esbarra no índice único
-- (organization_id, conversation_id).
--
-- DEPENDE DA 044: usa phone_key.
-- ============================================================

do $$
declare
  r record;
  v_fundidos int := 0;
  v_restantes int;
begin
  for r in
    with pares as (
      select c.organization_id, c.phone_key
      from public.crm_contacts c
      where c.phone_key is not null
      group by c.organization_id, c.phone_key
      having count(*) = 2
         and count(*) filter (where coalesce(c.sales_count, 0) > 0) = 1
    )
    select
      s.id                as sobrevivente,
      s.name              as nome_sobrevivente,
      l.id                as descartado,
      l.name              as nome_descartado,
      l.conversation_id   as conv_descartado,
      l.email             as email_descartado,
      l.origem            as origem_descartado,
      l.ctwaclid          as ctwaclid_descartado,
      l.tags              as tags_descartado
    from pares p
    join public.crm_contacts s
      on  s.organization_id = p.organization_id
      and s.phone_key = p.phone_key
      and coalesce(s.sales_count, 0) > 0
    join public.crm_contacts l
      on  l.organization_id = p.organization_id
      and l.phone_key = p.phone_key
      and coalesce(l.sales_count, 0) = 0
  loop
    -- Descartado com evento próprio não pode simplesmente sumir: se estiver
    -- pending, o worker perderia a entrega; se estiver sent, apagar apaga a
    -- prova do que já foi para a Meta. Nenhum dos pares conhecidos tem
    -- evento — se aparecer um, é situação nova e a migration para inteira em
    -- vez de decidir sozinha.
    if exists (select 1 from public.crm_events e where e.contact_id = r.descartado) then
      raise exception
        'Contato % (descartado, par de %) tem evento na Meta. Merge abortado: '
        'resolva o evento à mão antes de rodar esta migration.',
        r.descartado, r.sobrevivente;
    end if;

    -- Defensivo: pelo filtro acima o descartado tem sales_count zero, mas o
    -- contador é mantido por trigger e um contador errado não pode custar
    -- uma venda real.
    update public.crm_sales
      set contact_id = r.sobrevivente
    where contact_id = r.descartado;

    delete from public.crm_contacts where id = r.descartado;

    update public.crm_contacts s set
      conversation_id = coalesce(s.conversation_id, r.conv_descartado),
      email           = coalesce(s.email, r.email_descartado),
      origem          = coalesce(s.origem, r.origem_descartado),
      ctwaclid        = coalesce(s.ctwaclid, r.ctwaclid_descartado),
      tags            = (select array(select distinct unnest(s.tags || coalesce(r.tags_descartado, '{}')))),
      description     = case
        when r.nome_descartado is distinct from s.name
          then coalesce(s.description || E'\n', '')
               || 'Também cadastrado como: ' || r.nome_descartado
        else s.description
      end
    where s.id = r.sobrevivente;

    v_fundidos := v_fundidos + 1;
    raise notice 'Fundido: % <- % (%)', r.nome_sobrevivente, r.nome_descartado, r.descartado;
  end loop;

  raise notice '% contato(s) duplicado(s) fundido(s).', v_fundidos;

  -- Sobrou algo? São os pares ambíguos — os dois lados com venda, ou mais de
  -- dois contatos no mesmo número. Ficam para revisão no painel.
  select count(*) into v_restantes
  from (
    select 1
    from public.crm_contacts
    where phone_key is not null
    group by organization_id, phone_key
    having count(*) > 1
  ) t;

  if v_restantes > 0 then
    raise notice
      'ATENÇÃO: % telefone(s) ainda com mais de um contato — os dois lados '
      'venderam, ou há mais de dois registros. Precisam de decisão humana.',
      v_restantes;
  end if;
end $$;
