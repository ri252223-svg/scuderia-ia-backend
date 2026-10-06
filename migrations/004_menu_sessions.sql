-- SIKY MENU — sessão anônima do cliente.
--
-- O cliente nunca faz login: ele escaneia o QR da mesa e ganha um token de
-- sessão aleatório, guardado no navegador dele (localStorage). Esse token
-- é o que liga os próximos passos (carrinho, pedido) à mesa certa, sem
-- pedir nome/telefone/senha de ninguém.

create table menu_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  mesa_id uuid not null references menu_tables(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  criado_em timestamptz not null default now(),
  ultima_atividade timestamptz not null default now()
);
create index idx_menu_sessions_business on menu_sessions(business_id);
create index idx_menu_sessions_mesa on menu_sessions(mesa_id);
create index idx_menu_sessions_token on menu_sessions(token);

alter table menu_sessions enable row level security;
alter table menu_sessions force row level security;
create policy menu_sessions_isolamento on menu_sessions
  using (business_id = current_business_id())
  with check (business_id = current_business_id());
