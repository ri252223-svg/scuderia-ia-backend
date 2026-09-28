-- SIKY MENU — carrinho do cliente.
--
-- Cada linha pertence a uma sessão anônima (menu_sessions). O preço NÃO é
-- copiado pra cá: é sempre lido de menu_products na hora de listar, então
-- o cliente nunca consegue impor um preço próprio e mudanças de preço do
-- dono refletem no carrinho. (Na etapa de confirmação do pedido, o preço
-- será "congelado" no pedido.)

create table menu_cart_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  session_id uuid not null references menu_sessions(id) on delete cascade,
  product_id uuid not null references menu_products(id) on delete cascade,
  quantidade int not null check (quantidade > 0 and quantidade <= 50),
  observacao text not null default '',
  criado_em timestamptz not null default now()
);
create index idx_menu_cart_items_business on menu_cart_items(business_id);
create index idx_menu_cart_items_session on menu_cart_items(session_id);

alter table menu_cart_items enable row level security;
alter table menu_cart_items force row level security;
create policy menu_cart_items_isolamento on menu_cart_items
  using (business_id = current_business_id())
  with check (business_id = current_business_id());
