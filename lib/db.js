const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10
});

/**
 * Toda operação que pertence a uma empresa passa por aqui. Abre uma
 * transação, define o "quem sou eu" pro Postgres (que o RLS usa pra
 * filtrar), roda a função recebida, e fecha. Se o business_id nunca
 * for setado, o RLS bloqueia tudo — então esquecer de usar isso é uma
 * falha segura (nada retorna), não uma falha aberta.
 */
async function withTenant(businessId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET não aceita parâmetro ligado ($1) em Postgres — set_config() aceita.
    // O "true" no terceiro argumento é o equivalente a LOCAL (só a transação atual).
    await client.query(`SELECT set_config('app.current_business_id', $1, true)`, [businessId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* Só pra duas situações legítimas sem tenant ainda definido:
   1) login — precisa achar o usuário pelo e-mail antes de saber a empresa;
   2) criar uma empresa nova — o próprio código define o business_id
      (gerado em JS) e abre o tenant com ELE antes de inserir, então na
      prática toda escrita real ainda acontece com o contexto certo. */
async function withoutTenant(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function rowToService(r){ return r && { id:r.id, business_id:r.business_id, nome:r.nome, preco:Number(r.preco), duracao_min:r.duracao_min }; }
function rowToAutomation(r){ return r && { id:r.id, business_id:r.business_id, label:r.label, desc:r.descricao, on:r.ativo }; }
function rowToAppointment(r){ return r && { id:r.id, business_id:r.business_id, customer_id:r.customer_id, service_id:r.service_id, professional_id:r.professional_id, data: (r.data instanceof Date ? r.data.toISOString().slice(0,10) : r.data), hora: (r.hora||'').slice(0,5), status:r.status }; }

module.exports = {
  pool, withTenant, withoutTenant,

  // ---- businesses / auth ----
  async createBusiness(businessId, fields = {}) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into businesses (id, nome, responsavel_nome, whatsapp)
         values ($1,$2,$3,$4) returning *`,
        [businessId, fields.nome || '', fields.responsavel_nome || '', fields.whatsapp || '']
      );
      return r.rows[0];
    });
  },
  async findBusinessById(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from businesses where id = $1`, [businessId]);
      return r.rows[0] || null;
    });
  },
  async updateBusiness(businessId, changes) {
    return withTenant(businessId, async (c) => {
      const cols = Object.keys(changes);
      if (cols.length === 0) return null;
      const set = cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const r = await c.query(`update businesses set ${set} where id = $1 returning *`, [businessId, ...cols.map(k => changes[k])]);
      return r.rows[0];
    });
  },
  async createUser({ businessId, nome, email, senhaHash, role }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into users (business_id, nome, email, role, senha_hash)
         values ($1,$2,$3,$4,$5) returning id, business_id, nome, email, role, created_at`,
        [businessId, nome, email.toLowerCase(), role, senhaHash]
      );
      return r.rows[0];
    });
  },
  async findUserByEmail(email) {
    return withoutTenant(async (c) => {
      const r = await c.query(`select * from users where email = $1`, [email.toLowerCase()]);
      return r.rows[0] || null;
    });
  },
  async listUsersByBusiness(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select id, nome, email, role, created_at from users where business_id = $1 order by created_at`, [businessId]);
      return r.rows;
    });
  },

  // ---- customers ----
  async createCustomer(businessId, { nome, whatsapp }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into customers (business_id, nome, whatsapp) values ($1,$2,$3) returning *`,
        [businessId, nome, whatsapp || '']
      );
      return r.rows[0];
    });
  },
  async editCustomer(businessId, id, changes) {
    return withTenant(businessId, async (c) => {
      const cols = Object.keys(changes);
      if (cols.length === 0) return null;
      const set = cols.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const r = await c.query(`update customers set ${set} where id = $1 and business_id = $2 returning *`, [id, businessId, ...cols.map(k => changes[k])]);
      return r.rows[0] || null;
    });
  },
  async findCustomerByName(businessId, nome) {
    if (!nome) return null;
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `select * from customers where business_id = $1 and nome ilike '%'||$2||'%' order by criado_em desc limit 1`,
        [businessId, nome]
      );
      return r.rows[0] || null;
    });
  },

  // ---- services ----
  async createService(businessId, { nome, preco, duracao_min }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into services (business_id, nome, preco, duracao_min) values ($1,$2,$3,$4) returning *`,
        [businessId, nome, preco || 0, duracao_min || 30]
      );
      return rowToService(r.rows[0]);
    });
  },
  async editService(businessId, id, changes) {
    return withTenant(businessId, async (c) => {
      const cols = Object.keys(changes);
      if (cols.length === 0) return null;
      const set = cols.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const r = await c.query(`update services set ${set} where id = $1 and business_id = $2 returning *`, [id, businessId, ...cols.map(k => changes[k])]);
      return rowToService(r.rows[0]);
    });
  },
  async removeService(businessId, id) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`delete from services where id = $1 and business_id = $2 returning *`, [id, businessId]);
      return rowToService(r.rows[0]);
    });
  },
  async findServiceByName(businessId, nome) {
    if (!nome) return null;
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from services where business_id = $1 and nome ilike '%'||$2||'%' limit 1`, [businessId, nome]);
      return rowToService(r.rows[0]);
    });
  },
  async listServices(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from services where business_id = $1 order by nome`, [businessId]);
      return r.rows.map(rowToService);
    });
  },

  // ---- professionals ----
  async createProfessional(businessId, { nome }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`insert into professionals (business_id, nome) values ($1,$2) returning *`, [businessId, nome]);
      return r.rows[0];
    });
  },
  async editProfessional(businessId, id, changes) {
    return withTenant(businessId, async (c) => {
      const cols = Object.keys(changes);
      if (cols.length === 0) return null;
      const set = cols.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const r = await c.query(`update professionals set ${set} where id = $1 and business_id = $2 returning *`, [id, businessId, ...cols.map(k => changes[k])]);
      return r.rows[0] || null;
    });
  },
  async removeProfessional(businessId, id) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`delete from professionals where id = $1 and business_id = $2 returning *`, [id, businessId]);
      return r.rows[0] || null;
    });
  },
  async findProfessionalByName(businessId, nome) {
    if (!nome) return null;
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from professionals where business_id = $1 and nome ilike '%'||$2||'%' limit 1`, [businessId, nome]);
      return r.rows[0] || null;
    });
  },

  // ---- appointments ----
  async createAppointment(businessId, { customer_id, service_id, professional_id, data, hora }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into appointments (business_id, customer_id, service_id, professional_id, data, hora)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [businessId, customer_id, service_id, professional_id || null, data, hora]
      );
      return rowToAppointment(r.rows[0]);
    });
  },
  async listAppointments(businessId, { data, status } = {}) {
    return withTenant(businessId, async (c) => {
      const conds = ['business_id = $1'];
      const params = [businessId];
      if (data) { params.push(data); conds.push(`data = $${params.length}`); }
      if (status) { params.push(status); conds.push(`status = $${params.length}`); }
      const r = await c.query(`select * from appointments where ${conds.join(' and ')} order by data, hora`, params);
      return r.rows.map(rowToAppointment);
    });
  },
  async findActiveAppointmentByCustomer(businessId, customerId, filters = {}) {
    return withTenant(businessId, async (c) => {
      const conds = ['business_id = $1', 'customer_id = $2', `status = 'confirmado'`];
      const params = [businessId, customerId];
      if (filters.hora) { params.push(filters.hora); conds.push(`hora = $${params.length}`); }
      if (filters.data) { params.push(filters.data); conds.push(`data = $${params.length}`); }
      const r = await c.query(`select * from appointments where ${conds.join(' and ')} order by data, hora limit 1`, params);
      return rowToAppointment(r.rows[0]);
    });
  },
  async updateAppointment(businessId, id, changes) {
    return withTenant(businessId, async (c) => {
      const cols = Object.keys(changes);
      if (cols.length === 0) return null;
      const set = cols.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const r = await c.query(`update appointments set ${set} where id = $1 and business_id = $2 returning *`, [id, businessId, ...cols.map(k => changes[k])]);
      return rowToAppointment(r.rows[0]);
    });
  },

  // ---- automations ----
  async createAutomation(businessId, { label, desc }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into automations (business_id, label, descricao, ativo) values ($1,$2,$3,true) returning *`,
        [businessId, label, desc || 'Criada por comando']
      );
      return rowToAutomation(r.rows[0]);
    });
  },
  async updateAutomation(businessId, id, changes) {
    // changes usa os nomes "de fora" (label, desc, on) — traduz pras
    // colunas reais da tabela (descricao, ativo) antes do update.
    const colMap = { label: 'label', desc: 'descricao', on: 'ativo' };
    const cols = Object.keys(changes).filter(k => colMap[k]);
    if (cols.length === 0) return null;
    return withTenant(businessId, async (c) => {
      const set = cols.map((k, i) => `${colMap[k]} = $${i + 3}`).join(', ');
      const r = await c.query(`update automations set ${set} where id = $1 and business_id = $2 returning *`, [id, businessId, ...cols.map(k => changes[k])]);
      return rowToAutomation(r.rows[0]);
    });
  },
  async listAutomations(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from automations where business_id = $1 order by label`, [businessId]);
      return r.rows.map(rowToAutomation);
    });
  },

  // ---- payments ----
  async createPayment(businessId, payment) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into payments (business_id, customer_id, valor, status, external_id, pix_copia_cola)
         values ($1,$2,$3,'pendente',$4,$5) returning *`,
        [businessId, payment.customer_id, payment.valor, payment.external_id || null, payment.pix_copia_cola || null]
      );
      return r.rows[0];
    });
  },
  async updatePaymentStatus(externalId, status) {
    return withoutTenant(async (c) => {
      const r = await c.query(`update payments set status = $2 where external_id = $1 returning *`, [externalId, status]);
      return r.rows[0] || null;
    });
  },
  // Usado só pelo webhook do Mercado Pago: nesse momento ainda não
  // sabemos de qual empresa é o pagamento (só temos o id da cobrança),
  // então essa consulta roda sem tenant, só pra descobrir o business_id
  // — depois disso, toda leitura/escrita adicional já usa withTenant normalmente.
  async findPaymentByExternalId(externalId) {
    return withoutTenant(async (c) => {
      const r = await c.query(`select * from payments where external_id = $1`, [externalId]);
      return r.rows[0] || null;
    });
  },
  async findLatestPaymentByCustomer(businessId, customerId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `select * from payments where business_id = $1 and customer_id = $2 order by criado_em desc limit 1`,
        [businessId, customerId]
      );
      return r.rows[0] || null;
    });
  },

  // ---- assistant_actions (auditoria) ----
  async logAction(entry) {
    return withTenant(entry.business_id, async (c) => {
      const r = await c.query(
        `insert into assistant_actions (business_id, user_id, origem, comando, acao, params, status, mensagem)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [entry.business_id, entry.user_id || null, entry.origem, entry.comando, entry.acao, JSON.stringify(entry.params || {}), entry.status, entry.mensagem]
      );
      return r.rows[0];
    });
  },
  async listActions(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from assistant_actions where business_id = $1 order by "timestamp" desc limit 100`, [businessId]);
      return r.rows;
    });
  },

  // ---- Fase de IA, item 2: usado SÓ pelo agente (lib/agent.js) para
  // checar ambiguidade antes de propor uma ação — ex: existem 2 "João"?
  // Não é uma ACTION registrada (não passa por runAction/REQUIRES_OWNER),
  // é só leitura, não muda nada. findCustomerByName acima continua
  // intocada e é o que as ações existentes (criar_agendamento etc.)
  // continuam usando.
  async listCustomersByName(businessId, nome, limit = 5) {
    if (!nome) return [];
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `select * from customers where business_id = $1 and nome ilike '%'||$2||'%' order by criado_em desc limit $3`,
        [businessId, nome, limit]
      );
      return r.rows;
    });
  },

  // ---- usadas pelas telas administrativas (Dashboard/Clientes/Equipe) ----
  // listagem completa, sem filtro de nome — diferente de listCustomersByName
  // acima, que é só pra checagem de ambiguidade da IA.
  async listCustomers(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from customers where business_id = $1 order by nome`, [businessId]);
      return r.rows;
    });
  },
  async listProfessionals(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from professionals where business_id = $1 order by nome`, [businessId]);
      return r.rows;
    });
  },

  // ---- Conexão do Mercado Pago por empresa (modelo marketplace/OAuth) ----
  // Reaproveita a coluna "integracoes" (jsonb) que já existia desde a
  // primeira migration — não precisou de tabela nova nem migration nova.
  async getBusinessIntegracoes(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select integracoes from businesses where id = $1`, [businessId]);
      return (r.rows[0] && r.rows[0].integracoes) || {};
    });
  },
  async saveMercadoPagoConnection(businessId, { access_token, refresh_token, mp_user_id, public_key }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `update businesses set integracoes = jsonb_set(
           coalesce(integracoes, '{}'::jsonb),
           '{mercado_pago}',
           $2::jsonb,
           true
         ) where id = $1 returning integracoes`,
        [businessId, JSON.stringify({
          conectado: true, access_token, refresh_token, mp_user_id, public_key,
          conectado_em: new Date().toISOString()
        })]
      );
      return r.rows[0] && r.rows[0].integracoes;
    });
  },
  async disconnectMercadoPago(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `update businesses set integracoes = jsonb_set(
           coalesce(integracoes, '{}'::jsonb), '{mercado_pago}', $2::jsonb, true
         ) where id = $1 returning integracoes`,
        [businessId, JSON.stringify({ conectado: false })]
      );
      return r.rows[0] && r.rows[0].integracoes;
    });
  }
};
