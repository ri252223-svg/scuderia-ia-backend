-- ============================================================
-- SEED DE DESENVOLVIMENTO/TESTE — NUNCA RODAR EM PRODUÇÃO.
-- ============================================================
-- Tudo aqui é dado fictício, pra você ter uma empresa populada
-- pra testar sem precisar cadastrar tudo na mão. Nenhuma empresa
-- real nasce com esses dados — produção começa com o banco vazio,
-- e toda empresa real é criada pelo fluxo de cadastro (/auth/signup).
--
-- Usa crypt()/gen_salt('bf') do pgcrypto pra gerar um hash bcrypt
-- de verdade — o mesmo formato que o backend gera com a lib bcrypt
-- do Node, então o login funciona igual a uma conta real.
--
-- Rodar só em ambiente de desenvolvimento/staging:
--   psql "$DATABASE_URL" -f seeds/dev_seed.sql
-- ============================================================

do $$
declare
  v_business_id uuid := gen_random_uuid();
  v_service_corte uuid;
  v_prof_carla uuid;
  v_cliente_ana uuid;
begin
  -- Mesma regra do app real: toda escrita precisa do tenant definido
  -- primeiro (RLS com FORCE bloqueia até este script sem isso — e é
  -- isso mesmo que a gente quer, prova que a política vale pra todo mundo).
  perform set_config('app.current_business_id', v_business_id::text, false);

  insert into businesses (id, nome, responsavel_nome, whatsapp, endereco, horario, onboarding_completo, integracoes)
  values (
    v_business_id, 'Studio Bella (DEMO)', 'Ricardo', '(11) 98888-1234',
    'Rua das Flores, 120 — Centro', 'Seg a sáb, 9h às 19h', true,
    '{"whatsapp":{"conectado":true},"mercado_pago":{"conectado":true}}'::jsonb
  );

  insert into users (business_id, nome, email, role, senha_hash)
  values (v_business_id, 'Ricardo (demo)', 'demo@scuderia.ia', 'owner', crypt('demo123', gen_salt('bf')));

  insert into services (id, business_id, nome, preco, duracao_min) values
    (gen_random_uuid(), v_business_id, 'Corte', 60, 40),
    (gen_random_uuid(), v_business_id, 'Coloração', 150, 90);

  select id into v_service_corte from services where business_id = v_business_id and nome = 'Corte';

  insert into professionals (id, business_id, nome) values
    (gen_random_uuid(), v_business_id, 'Carla'),
    (gen_random_uuid(), v_business_id, 'Diego');
  select id into v_prof_carla from professionals where business_id = v_business_id and nome = 'Carla';

  insert into customers (id, business_id, nome, whatsapp) values
    (gen_random_uuid(), v_business_id, 'Ana', '(11) 91234-0001'),
    (gen_random_uuid(), v_business_id, 'João', '(11) 91234-0002');
  select id into v_cliente_ana from customers where business_id = v_business_id and nome = 'Ana';

  insert into appointments (business_id, customer_id, service_id, professional_id, data, hora, status)
  values (v_business_id, v_cliente_ana, v_service_corte, v_prof_carla, current_date + 1, '15:00', 'confirmado');

  insert into automations (business_id, label, descricao, ativo) values
    (v_business_id, 'Confirmação automática', 'Envia assim que o horário é marcado', true),
    (v_business_id, 'Lembrete 24h antes', 'Reduz faltas de última hora', true),
    (v_business_id, 'Lembrete 1h antes', 'Aviso final antes do horário', false);

  raise notice 'Seed de desenvolvimento criado. business_id = %', v_business_id;
end $$;
