-- SIKY MENU — fundação: cardápio digital via QR Code por mesa.
--
-- Dimensões reais (largura_cm/altura_cm/profundidade_cm) existem desde já
-- porque são o dado que vai permitir, mais pra frente, projetar o prato em
-- ESCALA REAL via WebAR na mesa do cliente — a IA nunca inventa essas
-- medidas, quem cadastra é o dono do negócio.

create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  nome text not null,
  ordem int not null default 0,
  criado_em timestamptz not null default now()
);
create index idx_menu_categories_business on menu_categories(business_id);

create table menu_products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  category_id uuid references menu_categories(id) on delete set null,
  nome text not null,
  descricao text not null default '',
  ingredientes text not null default '',
  preco numeric(10,2) not null default 0,
  disponivel boolean not null default true,
  -- Data URI (base64) ou URL — mesmo padrão já usado nos outros produtos dele.
  foto text,
  -- Dimensões reais do prato, em centímetros. Ficam nulas até o dono
  -- informar — a Siky NUNCA estima ou inventa um valor aqui.
  largura_cm numeric(6,2),
  altura_cm numeric(6,2),
  profundidade_cm numeric(6,2),
  criado_em timestamptz not null default now()
);
create index idx_menu_products_business on menu_products(business_id);
create index idx_menu_products_business_nome on menu_products(business_id, nome);
create index idx_menu_products_category on menu_products(category_id);

-- Fundação pra variações (tamanho P/M/G, sabores, adicionais...). Schema já
-- existe nesta etapa; as ferramentas de IA pra gerenciar isso ficam pra uma
-- próxima etapa, junto com o carrinho do cliente.
create table menu_option_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  product_id uuid not null references menu_products(id) on delete cascade,
  nome text not null,
  obrigatorio boolean not null default false,
  min_selecoes int not null default 0,
  max_selecoes int not null default 1
);
create index idx_menu_option_groups_business on menu_option_groups(business_id);
create index idx_menu_option_groups_product on menu_option_groups(product_id);

create table menu_options (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  group_id uuid not null references menu_option_groups(id) on delete cascade,
  nome text not null,
  preco_adicional numeric(10,2) not null default 0
);
create index idx_menu_options_business on menu_options(business_id);
create index idx_menu_options_group on menu_options(group_id);

create table menu_tables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  nome text not null,
  qr_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  ativa boolean not null default true,
  criado_em timestamptz not null default now()
);
create index idx_menu_tables_business on menu_tables(business_id);

-- RLS — mesmo padrão de 002_rls.sql: falha segura (0 linhas), nunca aberta.

alter table menu_categories enable row level security;
alter table menu_categories force row level security;
create policy menu_categories_isolamento on menu_categories
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table menu_products enable row level security;
alter table menu_products force row level security;
create policy menu_products_isolamento on menu_products
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table menu_option_groups enable row level security;
alter table menu_option_groups force row level security;
create policy menu_option_groups_isolamento on menu_option_groups
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table menu_options enable row level security;
alter table menu_options force row level security;
create policy menu_options_isolamento on menu_options
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table menu_tables enable row level security;
alter table menu_tables force row level security;
create policy menu_tables_isolamento on menu_tables
  using (business_id = current_business_id())
  with check (business_id = current_business_id());
