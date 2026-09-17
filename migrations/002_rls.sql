-- Fase 5 — Row Level Security: isolamento entre empresas garantido
-- pelo próprio Postgres, não só pelo código do backend.
--
-- O backend define, no início de cada transação:
--   SET LOCAL app.current_business_id = '<uuid da empresa do token>';
-- e toda política abaixo filtra por esse valor. Se o backend esquecer
-- de definir isso (bug), current_setting(...) retorna vazio e a
-- comparação falha — ou seja, a consulta não devolve NADA em vez de
-- devolver tudo. Falha segura, não falha aberta.
--
-- FORCE ROW LEVEL SECURITY é usado pra que a política valha mesmo pra
-- conexões feitas com o usuário "dono" das tabelas (nosso backend) —
-- sem isso, o dono da tabela ignora RLS por padrão no Postgres.

create or replace function current_business_id() returns uuid as $$
  select nullif(current_setting('app.current_business_id', true), '')::uuid
$$ language sql stable;

alter table businesses enable row level security;
alter table businesses force row level security;
create policy biz_isolamento on businesses
  using (id = current_business_id());

alter table customers enable row level security;
alter table customers force row level security;
create policy customers_isolamento on customers
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table services enable row level security;
alter table services force row level security;
create policy services_isolamento on services
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table professionals enable row level security;
alter table professionals force row level security;
create policy professionals_isolamento on professionals
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table appointments enable row level security;
alter table appointments force row level security;
create policy appointments_isolamento on appointments
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table automations enable row level security;
alter table automations force row level security;
create policy automations_isolamento on automations
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table payments enable row level security;
alter table payments force row level security;
create policy payments_isolamento on payments
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

alter table assistant_actions enable row level security;
alter table assistant_actions force row level security;
create policy actions_isolamento on assistant_actions
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

-- users NÃO tem RLS por business_id: o login precisa localizar um
-- usuário pelo e-mail ANTES de sabermos a que empresa ele pertence
-- (é o próprio propósito do login). Esse é o motivo documentado no
-- plano técnico — o isolamento entre empresas continua garantido nas
-- outras 8 tabelas, que são onde o dado operacional realmente vive.
-- O código do backend nunca lista/edita usuário de outra empresa
-- porque toda consulta a "users" fora do login já filtra business_id
-- explicitamente (ver lib/db.js).
