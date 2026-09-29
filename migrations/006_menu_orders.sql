-- SIKY MENU — confirmação de pedido.
--
-- Ao confirmar, o carrinho vira um pedido e os preços/nomes são CONGELADOS
-- em menu_order_items: se o dono mudar preço ou apagar o prato depois, o
-- pedido já feito não muda. O status começa em 'recebido'; quem muda os
-- status depois é o painel da cozinha (KDS), próxima etapa.

create table menu_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  session_id uuid not null references menu_sessions(id) on delete cascade,
  mesa_id uuid not null references menu_tables(id) on delete cascade,
  numero int not null,
  status text not null default 'recebido'
    check (status in ('recebido','preparando','pronto','entregue','cancelado')),
  observacao text not null default '',
  total numeric(10,2) not null,
  criado_em timestamptz not null default now(),
  unique (business_id, numero)
);
create index idx_menu_orders_business on menu_orders(business_id);
create index idx_menu_orders_session on menu_orders(session_id);
create index idx_menu_orders_status on menu_orders(business_id, status);

create table menu_order_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  order_id uuid not null references menu_orders(id) on delete cascade,
  product_id uuid references menu_products(id) on delete set null,
  nome text not null,
  preco_unitario numeric(10,2) not null,
  quantidade int not null check (quantidade > 0),
  observacao text not null default '',
  subtotal numeric(10,2) not null
);
create index idx_menu_order_items_business on menu_order_items(business_id);
create index idx_menu_order_items_order on menu_order_items(order_id);

alter table menu_orders enable row level security;
alter table menu_orders force row level security;
create policy menu_orders_isolamento on menu_orders
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table menu_order_items enable row level security;
alter table menu_order_items force row level security;
create policy menu_order_items_isolamento on menu_order_items
  using (business_id = current_business_id())
  with check (business_id = current_business_id());
