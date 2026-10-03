-- SIKY MENU — comandas compartilhadas.
--
-- Mudança de modelo: até aqui o carrinho e o pedido pertenciam à SESSÃO
-- (uma pessoa, um carrinho). Agora passam a pertencer à COMANDA — o número
-- físico que o estabelecimento já usa. Quem digita o mesmo número de
-- comanda na mesma mesa cai no mesmo carrinho e vê os mesmos pedidos,
-- exatamente como uma família/grupo de amigos dividindo a conta.
--
-- menu_sessions continua existindo: ainda é "um navegador/pessoa que
-- escaneou o QR", só que agora ela só pode mexer em carrinho/pedido depois
-- de escolher (ou criar) uma comanda — por isso o comanda_id começa nulo.
--
-- Isso é um projeto ainda em desenvolvimento, sem clientes reais usando —
-- por isso os dados de teste de carrinho/pedido são zerados aqui em vez de
-- migrados; nada de categoria, produto ou mesa é afetado.

create table menu_comandas (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  mesa_id uuid not null references menu_tables(id) on delete cascade,
  numero text not null,
  status text not null default 'aberta' check (status in ('aberta','fechada')),
  criado_em timestamptz not null default now(),
  fechado_em timestamptz
);
create index idx_menu_comandas_business on menu_comandas(business_id);
create index idx_menu_comandas_mesa on menu_comandas(mesa_id);
-- Só pode haver UMA comanda aberta com esse número, nessa mesa, ao mesmo
-- tempo — depois de fechada, o número pode ser reaberto (comanda do dia
-- seguinte, por exemplo).
create unique index idx_menu_comandas_numero_aberta
  on menu_comandas(business_id, mesa_id, numero) where (status = 'aberta');

alter table menu_comandas enable row level security;
alter table menu_comandas force row level security;
create policy menu_comandas_isolamento on menu_comandas
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

-- A sessão só sabe em qual comanda está depois que a pessoa digita o
-- número — por isso nullable.
alter table menu_sessions add column comanda_id uuid references menu_comandas(id) on delete set null;
create index idx_menu_sessions_comanda on menu_sessions(comanda_id);

-- Carrinho: era por sessão, agora é por comanda (compartilhado).
truncate table menu_cart_items;
alter table menu_cart_items drop column session_id;
alter table menu_cart_items add column comanda_id uuid not null references menu_comandas(id) on delete cascade;
create index idx_menu_cart_items_comanda on menu_cart_items(comanda_id);

-- Pedido: era por sessão, agora é por comanda (compartilhado).
truncate table menu_order_items, menu_orders;
alter table menu_orders drop column session_id;
alter table menu_orders add column comanda_id uuid not null references menu_comandas(id) on delete cascade;
create index idx_menu_orders_comanda on menu_orders(comanda_id);
