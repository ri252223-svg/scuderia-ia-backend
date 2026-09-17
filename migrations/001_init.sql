-- Fase 5 — schema inicial da Scuderia IA
create extension if not exists pgcrypto;

create table businesses (
  id uuid primary key default gen_random_uuid(),
  nome text not null default '',
  responsavel_nome text not null default '',
  whatsapp text not null default '',
  endereco text not null default '',
  horario text not null default '',
  onboarding_completo boolean not null default false,
  onboarding_step int not null default -1,
  integracoes jsonb not null default '{"whatsapp":{"conectado":false},"mercado_pago":{"conectado":false}}'::jsonb,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  nome text not null,
  email text not null unique,
  role text not null default 'owner' check (role in ('owner','staff')),
  senha_hash text not null,
  created_at timestamptz not null default now()
);
create index idx_users_business on users(business_id);

create table customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  nome text not null,
  whatsapp text not null default '',
  criado_em timestamptz not null default now()
);
create index idx_customers_business on customers(business_id);
create index idx_customers_business_nome on customers(business_id, nome);

create table services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  nome text not null,
  preco numeric(10,2) not null default 0,
  duracao_min int not null default 30
);
create index idx_services_business on services(business_id);

create table professionals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  nome text not null
);
create index idx_professionals_business on professionals(business_id);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  service_id uuid references services(id) on delete set null,
  professional_id uuid references professionals(id) on delete set null,
  data date not null,
  hora time not null,
  status text not null default 'confirmado' check (status in ('confirmado','cancelado')),
  criado_em timestamptz not null default now()
);
create index idx_appointments_business on appointments(business_id);
create index idx_appointments_business_data on appointments(business_id, data);

create table automations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  label text not null,
  descricao text not null default '',
  ativo boolean not null default true
);
create index idx_automations_business on automations(business_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  valor numeric(10,2) not null,
  status text not null default 'pendente',
  external_id text,
  pix_copia_cola text,
  criado_em timestamptz not null default now()
);
create index idx_payments_business on payments(business_id);

create table assistant_actions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  "timestamp" timestamptz not null default now(),
  origem text,
  comando text,
  acao text,
  params jsonb,
  status text,
  mensagem text
);
create index idx_actions_business on assistant_actions(business_id);
