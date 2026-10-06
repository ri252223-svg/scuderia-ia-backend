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
function rowToMenuCategory(r){ return r && { id:r.id, business_id:r.business_id, nome:r.nome, ordem:r.ordem }; }
function rowToMenuProduct(r){
  return r && {
    id: r.id, business_id: r.business_id, category_id: r.category_id,
    nome: r.nome, descricao: r.descricao, ingredientes: r.ingredientes,
    preco: Number(r.preco), disponivel: r.disponivel, foto: r.foto,
    largura_cm: r.largura_cm === null ? null : Number(r.largura_cm),
    altura_cm: r.altura_cm === null ? null : Number(r.altura_cm),
    profundidade_cm: r.profundidade_cm === null ? null : Number(r.profundidade_cm)
  };
}
function rowToMenuTable(r){ return r && { id:r.id, business_id:r.business_id, nome:r.nome, qr_token:r.qr_token, ativa:r.ativa }; }
function rowToCartItem(r){
  return r && {
    id: r.id, product_id: r.product_id, nome: r.nome, foto: r.foto,
    preco_unitario: Number(r.preco), disponivel: r.disponivel,
    quantidade: r.quantidade, observacao: r.observacao,
    subtotal: Math.round(Number(r.preco) * r.quantidade * 100) / 100
  };
}
function rowToMenuSession(r){ return r && { id:r.id, business_id:r.business_id, mesa_id:r.mesa_id, comanda_id:r.comanda_id, token:r.token, criado_em:r.criado_em, ultima_atividade:r.ultima_atividade }; }
function rowToComanda(r){ return r && { id:r.id, business_id:r.business_id, mesa_id:r.mesa_id, numero:r.numero, status:r.status }; }
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
  },

  // ---- menu (cardápio digital / SIKY MENU) ----
  async createMenuCategory(businessId, { nome, ordem }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into menu_categories (business_id, nome, ordem) values ($1,$2,$3) returning *`,
        [businessId, nome, ordem || 0]
      );
      return rowToMenuCategory(r.rows[0]);
    });
  },
  async findMenuCategoryByName(businessId, nome) {
    if (!nome) return null;
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from menu_categories where business_id = $1 and nome ilike '%'||$2||'%' limit 1`, [businessId, nome]);
      return rowToMenuCategory(r.rows[0]);
    });
  },
  async listMenuCategories(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from menu_categories where business_id = $1 order by ordem, nome`, [businessId]);
      return r.rows.map(rowToMenuCategory);
    });
  },

  async createMenuProduct(businessId, { category_id, nome, descricao, ingredientes, preco, foto, largura_cm, altura_cm, profundidade_cm }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `insert into menu_products
           (business_id, category_id, nome, descricao, ingredientes, preco, foto, largura_cm, altura_cm, profundidade_cm)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [businessId, category_id || null, nome, descricao || '', ingredientes || '', preco || 0, foto || null,
         largura_cm ?? null, altura_cm ?? null, profundidade_cm ?? null]
      );
      return rowToMenuProduct(r.rows[0]);
    });
  },
  async editMenuProduct(businessId, id, changes) {
    return withTenant(businessId, async (c) => {
      const cols = Object.keys(changes);
      if (cols.length === 0) return null;
      const set = cols.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const r = await c.query(
        `update menu_products set ${set} where id = $1 and business_id = $2 returning *`,
        [id, businessId, ...cols.map(k => changes[k])]
      );
      return rowToMenuProduct(r.rows[0]);
    });
  },
  async removeMenuProduct(businessId, id) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`delete from menu_products where id = $1 and business_id = $2 returning *`, [id, businessId]);
      return rowToMenuProduct(r.rows[0]);
    });
  },
  async findMenuProductByName(businessId, nome) {
    if (!nome) return null;
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from menu_products where business_id = $1 and nome ilike '%'||$2||'%' limit 1`, [businessId, nome]);
      return rowToMenuProduct(r.rows[0]);
    });
  },
  async listMenuProducts(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `select p.*, cat.nome as categoria_nome
           from menu_products p
           left join menu_categories cat on cat.id = p.category_id
          where p.business_id = $1
          order by cat.ordem nulls last, p.nome`,
        [businessId]
      );
      return r.rows.map(row => Object.assign(rowToMenuProduct(row), { categoria_nome: row.categoria_nome || null }));
    });
  },

  async createMenuTable(businessId, { nome }) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`insert into menu_tables (business_id, nome) values ($1,$2) returning *`, [businessId, nome]);
      return rowToMenuTable(r.rows[0]);
    });
  },
  async findMenuTableByName(businessId, nome) {
    if (!nome) return null;
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from menu_tables where business_id = $1 and nome ilike '%'||$2||'%' limit 1`, [businessId, nome]);
      return rowToMenuTable(r.rows[0]);
    });
  },
  async setMenuTableAtiva(businessId, id, ativa) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`update menu_tables set ativa = $3 where id = $1 and business_id = $2 returning *`, [id, businessId, ativa]);
      return rowToMenuTable(r.rows[0]);
    });
  },
  async listMenuTables(businessId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from menu_tables where business_id = $1 order by nome`, [businessId]);
      return r.rows.map(rowToMenuTable);
    });
  },
  async findMenuTableByToken(qrToken) {
    // Único caso de leitura de menu_tables sem tenant definido: o cliente
    // chega com só o qr_token (sem saber a que empresa a mesa pertence),
    // exatamente como o login localiza o usuário pelo e-mail antes de
    // saber a empresa. A sessão do cliente (próxima etapa) é quem passa
    // a abrir o tenant certo a partir do business_id que ESTA consulta
    // devolve — nunca aceito de fora.
    return withoutTenant(async (c) => {
      const r = await c.query(`select * from menu_tables where qr_token = $1 and ativa = true`, [qrToken]);
      return rowToMenuTable(r.rows[0]);
    });
  },

  // ---- sessão anônima do cliente (SIKY MENU) ----
  async createMenuSession(businessId, mesaId) {
    // Mesmo caso do findMenuTableByToken: quem cria a sessão é o cliente
    // anônimo escaneando o QR, então o business_id vem de dentro da própria
    // função (já resolvido pelo qr_token um passo antes), nunca de fora.
    return withoutTenant(async (c) => {
      const r = await c.query(
        `insert into menu_sessions (business_id, mesa_id) values ($1,$2) returning *`,
        [businessId, mesaId]
      );
      return rowToMenuSession(r.rows[0]);
    });
  },
  async findMenuSessionByToken(token) {
    if (!token) return null;
    return withoutTenant(async (c) => {
      const r = await c.query(`select * from menu_sessions where token = $1`, [token]);
      return rowToMenuSession(r.rows[0]);
    });
  },
  async touchMenuSession(token) {
    return withoutTenant(async (c) => {
      const r = await c.query(
        `update menu_sessions set ultima_atividade = now() where token = $1 returning *`,
        [token]
      );
      return rowToMenuSession(r.rows[0]);
    });
  },

  // ---- comandas (SIKY MENU) ----
  // "Entrar numa comanda": se já existe uma ABERTA com esse número nessa
  // mesa, entra nela (e todo mundo que já estava passa a dividir o mesmo
  // carrinho); senão, abre uma nova. Tudo pelo caminho sem tenant porque
  // quem chama ainda é o cliente anônimo, só com o mesa_id já resolvido
  // pelo qr_token um passo antes (igual ao findMenuTableByToken).
  async joinOrCreateComanda(businessId, mesaId, numero) {
    return withoutTenant(async (c) => {
      const ex = await c.query(
        `select * from menu_comandas where business_id = $1 and mesa_id = $2 and numero = $3 and status = 'aberta'`,
        [businessId, mesaId, numero]
      );
      if (ex.rows[0]) return rowToComanda(ex.rows[0]);
      const r = await c.query(
        `insert into menu_comandas (business_id, mesa_id, numero) values ($1,$2,$3) returning *`,
        [businessId, mesaId, numero]
      );
      return rowToComanda(r.rows[0]);
    });
  },
  async getComandaById(businessId, id) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from menu_comandas where id = $1 and business_id = $2`, [id, businessId]);
      return rowToComanda(r.rows[0]);
    });
  },
  async setSessionComanda(sessionToken, comandaId) {
    return withoutTenant(async (c) => {
      const r = await c.query(
        `update menu_sessions set comanda_id = $2 where token = $1 returning *`,
        [sessionToken, comandaId]
      );
      return rowToMenuSession(r.rows[0]);
    });
  },

  // ---- carrinho da COMANDA (SIKY MENU) ----
  // O carrinho é compartilhado por todo mundo que digitou o mesmo número de
  // comanda — por isso essas funções recebem comandaId, nunca sessionId.
  // Sempre chamadas com business_id/comanda_id já validados pelo servidor.
  async getMenuProductById(businessId, id) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select * from menu_products where id = $1 and business_id = $2`, [id, businessId]);
      return rowToMenuProduct(r.rows[0]);
    });
  },
  async addCartItem(businessId, comandaId, { productId, quantidade, observacao }) {
    return withTenant(businessId, async (c) => {
      // Mesmo prato + mesma observação = soma na linha existente (de qualquer pessoa da comanda).
      const ex = await c.query(
        `select id, quantidade from menu_cart_items
          where comanda_id = $1 and product_id = $2 and observacao = $3`,
        [comandaId, productId, observacao]
      );
      if (ex.rows[0]) {
        const nova = Math.min(50, ex.rows[0].quantidade + quantidade);
        await c.query(`update menu_cart_items set quantidade = $2 where id = $1`, [ex.rows[0].id, nova]);
        return ex.rows[0].id;
      }
      const r = await c.query(
        `insert into menu_cart_items (business_id, comanda_id, product_id, quantidade, observacao)
         values ($1,$2,$3,$4,$5) returning id`,
        [businessId, comandaId, productId, quantidade, observacao]
      );
      return r.rows[0].id;
    });
  },
  async listCartItems(businessId, comandaId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `select i.id, i.product_id, i.quantidade, i.observacao,
                p.nome, p.foto, p.preco, p.disponivel
           from menu_cart_items i
           join menu_products p on p.id = i.product_id
          where i.comanda_id = $1
          order by i.criado_em`,
        [comandaId]
      );
      return r.rows.map(rowToCartItem);
    });
  },
  async setCartItemQuantity(businessId, comandaId, itemId, quantidade) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `update menu_cart_items set quantidade = $3 where id = $1 and comanda_id = $2 returning id`,
        [itemId, comandaId, quantidade]
      );
      return !!r.rows[0];
    });
  },
  async removeCartItem(businessId, comandaId, itemId) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(`delete from menu_cart_items where id = $1 and comanda_id = $2 returning id`, [itemId, comandaId]);
      return !!r.rows[0];
    });
  },

  // ---- pedidos (SIKY MENU) ----
  // Converte o carrinho da COMANDA em pedido, tudo numa transação só: valida,
  // congela preços, grava o pedido (visível pra todo mundo da comanda) e
  // esvazia o carrinho compartilhado. Devolve { erro } (sem gravar nada)
  // quando não dá pra confirmar.
  async createOrderFromCart(businessId, comandaId, observacao) {
    return withTenant(businessId, async (c) => {
      // Serializa pedidos da mesma empresa pra numeração sequencial sem buraco/duplicata.
      await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [businessId]);

      const com = await c.query(
        `select cm.mesa_id, t.ativa from menu_comandas cm
           join menu_tables t on t.id = cm.mesa_id
          where cm.id = $1`, [comandaId]);
      if (!com.rows[0] || !com.rows[0].ativa) return { erro: 'mesa_inativa' };
      const mesaId = com.rows[0].mesa_id;

      const cart = await c.query(
        `select i.product_id, i.quantidade, i.observacao, p.nome, p.preco, p.disponivel
           from menu_cart_items i join menu_products p on p.id = i.product_id
          where i.comanda_id = $1 order by i.criado_em`, [comandaId]);
      if (cart.rows.length === 0) return { erro: 'vazio' };
      const indisp = cart.rows.filter(x => !x.disponivel).map(x => x.nome);
      if (indisp.length) return { erro: 'indisponiveis', itens: indisp };

      const linhas = cart.rows.map(x => {
        const cents = Math.round(Number(x.preco) * 100);
        return { ...x, cents, subtotalCents: cents * x.quantidade };
      });
      const totalCents = linhas.reduce((t, l) => t + l.subtotalCents, 0);

      const n = await c.query(`select coalesce(max(numero),0)+1 as n from menu_orders where business_id = $1`, [businessId]);
      const o = await c.query(
        `insert into menu_orders (business_id, comanda_id, mesa_id, numero, observacao, total)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [businessId, comandaId, mesaId, n.rows[0].n, observacao || '', totalCents / 100]);
      const orderId = o.rows[0].id;
      for (const l of linhas) {
        await c.query(
          `insert into menu_order_items (business_id, order_id, product_id, nome, preco_unitario, quantidade, observacao, subtotal)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [businessId, orderId, l.product_id, l.nome, l.cents / 100, l.quantidade, l.observacao, l.subtotalCents / 100]);
      }
      await c.query(`delete from menu_cart_items where comanda_id = $1`, [comandaId]);
      return { orderId };
    }).then(async (r) => (r.erro ? r : { pedido: (await module.exports.listOrders(businessId, r.orderId, 'id'))[0] }));
  },
  // by = 'comanda' (todos os pedidos da comanda) ou 'id' (um pedido específico)
  async listOrders(businessId, key, by = 'comanda') {
    return withTenant(businessId, async (c) => {
      const col = by === 'id' ? 'id' : 'comanda_id';
      const os = await c.query(`select * from menu_orders where ${col} = $1 order by criado_em`, [key]);
      const out = [];
      for (const o of os.rows) {
        const it = await c.query(
          `select nome, preco_unitario, quantidade, observacao, subtotal
             from menu_order_items where order_id = $1 order by nome`, [o.id]);
        out.push({
          id: o.id, numero: o.numero, status: o.status, observacao: o.observacao,
          total: Number(o.total), criado_em: o.criado_em,
          itens: it.rows.map(x => ({
            nome: x.nome, preco_unitario: Number(x.preco_unitario), quantidade: x.quantidade,
            observacao: x.observacao, subtotal: Number(x.subtotal)
          }))
        });
      }
      return out;
    });
  },

  // Painel da cozinha: pedidos da empresa toda (não de uma sessão só),
  // já filtrados/ordenados pra fila de preparo.
  async listOrdersForBusiness(businessId, status) {
    return withTenant(businessId, async (c) => {
      const where = status ? `where o.business_id = $1 and o.status = $2` : `where o.business_id = $1`;
      const params = status ? [businessId, status] : [businessId];
      const os = await c.query(
        `select o.*, t.nome as mesa_nome, cm.numero as comanda_numero
           from menu_orders o
           join menu_tables t on t.id = o.mesa_id
           join menu_comandas cm on cm.id = o.comanda_id
          ${where} order by o.criado_em`, params);
      const out = [];
      for (const o of os.rows) {
        const it = await c.query(
          `select nome, preco_unitario, quantidade, observacao, subtotal
             from menu_order_items where order_id = $1 order by nome`, [o.id]);
        out.push({
          id: o.id, numero: o.numero, status: o.status, observacao: o.observacao,
          mesa_nome: o.mesa_nome, comanda_numero: o.comanda_numero, total: Number(o.total), criado_em: o.criado_em,
          itens: it.rows.map(x => ({
            nome: x.nome, preco_unitario: Number(x.preco_unitario), quantidade: x.quantidade,
            observacao: x.observacao, subtotal: Number(x.subtotal)
          }))
        });
      }
      return out;
    });
  },
  async findOrderByNumero(businessId, numero) {
    const n = Number(numero);
    if (!Number.isInteger(n)) return null;
    return withTenant(businessId, async (c) => {
      const r = await c.query(`select id, numero from menu_orders where business_id = $1 and numero = $2`, [businessId, n]);
      return r.rows[0] || null;
    });
  },
  async setOrderStatus(businessId, orderId, status) {
    return withTenant(businessId, async (c) => {
      const r = await c.query(
        `update menu_orders set status = $3 where id = $1 and business_id = $2 returning id, numero, status`,
        [orderId, businessId, status]
      );
      return r.rows[0] || null;
    });
  }
};
