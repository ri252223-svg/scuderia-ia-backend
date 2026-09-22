/**
 * Camada de ações controladas — agora batendo no Postgres de verdade
 * (via lib/db.js), não mais em memória.
 *
 * A IA (lib/ai.js) NUNCA chama o banco ou a Meta/Mercado Pago
 * diretamente. Ela só escolhe um nome de ação + parâmetros, e este
 * arquivo é o único lugar que efetivamente lê/escreve dados e dispara
 * efeitos externos (mensagem no WhatsApp, cobrança Pix — ambos ainda
 * SIMULADOS nesta fase, como pedido: nenhuma API externa é chamada).
 */
 
module.exports = function createActions({ db, sendWhatsAppMessage, createPixCharge }) {
  function fmtData(iso) {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const isoToday = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const tmr = new Date(today); tmr.setDate(tmr.getDate() + 1);
    const isoTmr = tmr.getFullYear() + '-' + pad(tmr.getMonth() + 1) + '-' + pad(tmr.getDate());
    if (iso === isoToday) return 'hoje';
    if (iso === isoTmr) return 'amanhã';
    const [, m, d] = String(iso).split('-');
    return d + '/' + m;
  }
 
  const ACTIONS = {
    async criar_cliente(businessId, { nome, whatsapp }) {
      if (!nome) return { ok: false, mensagem: 'Preciso do nome do cliente.' };
      const c = await db.createCustomer(businessId, { nome, whatsapp });
      return { ok: true, mensagem: 'Cliente ' + nome + ' cadastrado.', data: c };
    },
    async buscar_cliente(businessId, { nome }) {
      const c = await db.findCustomerByName(businessId, nome);
      return { ok: true, mensagem: c ? 'Cliente encontrado: ' + c.nome + '.' : 'Nenhum cliente encontrado.', data: c };
    },
    async editar_cliente(businessId, { id, changes }) {
      const c = await db.editCustomer(businessId, id, changes || {});
      if (!c) return { ok: false, mensagem: 'Cliente não encontrado.' };
      return { ok: true, mensagem: 'Cliente atualizado.', data: c };
    },
 
    async criar_servico(businessId, { nome, preco, duracao_min }) {
      if (!nome) return { ok: false, mensagem: 'Preciso do nome do serviço.' };
      const p = parseFloat(preco);
      const s = await db.createService(businessId, { nome, preco: isNaN(p) ? 0 : p, duracao_min: duracao_min ? parseInt(duracao_min) : 30 });
      return { ok: true, mensagem: 'Serviço ' + nome + ' adicionado.', data: s };
    },
    async editar_servico(businessId, { id, changes }) {
      const s = await db.editService(businessId, id, changes || {});
      if (!s) return { ok: false, mensagem: 'Serviço não encontrado.' };
      return { ok: true, mensagem: 'Serviço atualizado.', data: s };
    },
    async remover_servico(businessId, { id }) {
      const s = await db.removeService(businessId, id);
      if (!s) return { ok: false, mensagem: 'Serviço não encontrado.' };
      return { ok: true, mensagem: 'Serviço ' + s.nome + ' removido.', data: s };
    },
 
    // ---- cardápio digital (SIKY MENU) ----
    async criar_categoria_cardapio(businessId, { nome, ordem }) {
      if (!nome) return { ok: false, mensagem: 'Preciso do nome da categoria.' };
      const cat = await db.createMenuCategory(businessId, { nome, ordem });
      return { ok: true, mensagem: 'Categoria ' + nome + ' criada.', data: cat };
    },
    async criar_produto_cardapio(businessId, { categoriaNome, nome, descricao, ingredientes, preco, foto, largura_cm, altura_cm, profundidade_cm }) {
      if (!nome) return { ok: false, mensagem: 'Preciso do nome do prato/lanche.' };
      let category_id = null;
      if (categoriaNome) {
        const cat = await db.findMenuCategoryByName(businessId, categoriaNome);
        if (!cat) return { ok: false, mensagem: 'Categoria "' + categoriaNome + '" não encontrada.' };
        category_id = cat.id;
      }
      const p = parseFloat(preco);
      const prod = await db.createMenuProduct(businessId, {
        category_id, nome, descricao, ingredientes,
        preco: isNaN(p) ? 0 : p, foto,
        largura_cm, altura_cm, profundidade_cm
      });
      return { ok: true, mensagem: 'Prato ' + nome + ' adicionado ao cardápio.', data: prod };
    },
    async editar_produto_cardapio(businessId, { id, changes }) {
      const p = await db.editMenuProduct(businessId, id, changes || {});
      if (!p) return { ok: false, mensagem: 'Produto não encontrado.' };
      return { ok: true, mensagem: 'Prato atualizado.', data: p };
    },
    async remover_produto_cardapio(businessId, { id }) {
      const p = await db.removeMenuProduct(businessId, id);
      if (!p) return { ok: false, mensagem: 'Produto não encontrado.' };
      return { ok: true, mensagem: 'Prato ' + p.nome + ' removido do cardápio.', data: p };
    },
    async consultar_cardapio(businessId) {
      const produtos = await db.listMenuProducts(businessId);
      return { ok: true, mensagem: produtos.length ? 'Cardápio com ' + produtos.length + ' item(ns).' : 'Cardápio ainda vazio.', data: produtos };
    },
 
    async criar_mesa(businessId, { nome }) {
      if (!nome) return { ok: false, mensagem: 'Preciso do nome/número da mesa.' };
      const mesa = await db.createMenuTable(businessId, { nome });
      return { ok: true, mensagem: 'Mesa ' + nome + ' criada.', data: mesa };
    },
    async desativar_mesa(businessId, { id }) {
      const mesa = await db.setMenuTableAtiva(businessId, id, false);
      if (!mesa) return { ok: false, mensagem: 'Mesa não encontrada.' };
      return { ok: true, mensagem: 'Mesa ' + mesa.nome + ' desativada.', data: mesa };
    },
    async consultar_mesas(businessId) {
      const mesas = await db.listMenuTables(businessId);
      return { ok: true, mensagem: mesas.length ? mesas.length + ' mesa(s) cadastrada(s).' : 'Nenhuma mesa cadastrada ainda.', data: mesas };
    },
 
    async criar_profissional(businessId, { nome }) {
      if (!nome) return { ok: false, mensagem: 'Preciso do nome do profissional.' };
      const p = await db.createProfessional(businessId, { nome });
      return { ok: true, mensagem: 'Profissional ' + nome + ' adicionado.', data: p };
    },
    async editar_profissional(businessId, { id, changes }) {
      const p = await db.editProfessional(businessId, id, changes || {});
      if (!p) return { ok: false, mensagem: 'Profissional não encontrado.' };
      return { ok: true, mensagem: 'Profissional atualizado.', data: p };
    },
    async remover_profissional(businessId, { id }) {
      const p = await db.removeProfessional(businessId, id);
      if (!p) return { ok: false, mensagem: 'Profissional não encontrado.' };
      return { ok: true, mensagem: 'Profissional ' + p.nome + ' removido.', data: p };
    },
 
    async criar_agendamento(businessId, { clienteNome, servicoNome, profissionalNome, data, hora }) {
      const cliente = await db.findCustomerByName(businessId, clienteNome);
      if (!cliente) return { ok: false, mensagem: 'Não encontrei o cliente "' + clienteNome + '".' };
      const servico = servicoNome ? await db.findServiceByName(businessId, servicoNome) : (await db.listServices(businessId))[0];
      if (!servico) return { ok: false, mensagem: 'Não encontrei o serviço "' + servicoNome + '".' };
      const profissional = profissionalNome ? await db.findProfessionalByName(businessId, profissionalNome) : null;
      const apt = await db.createAppointment(businessId, { customer_id: cliente.id, service_id: servico.id, professional_id: profissional ? profissional.id : null, data, hora });
      return { ok: true, mensagem: 'Agendamento de ' + cliente.nome + ' criado para ' + fmtData(apt.data) + ' às ' + apt.hora + '.', data: apt };
    },
    async consultar_agenda(businessId, { data }) {
      const items = await db.listAppointments(businessId, { data, status: 'confirmado' });
      if (items.length === 0) return { ok: true, mensagem: 'Nada agendado para ' + fmtData(data) + '.', data: items };
      const desc = items.map(a => a.hora).join(', ');
      return { ok: true, mensagem: 'Agenda de ' + fmtData(data) + ': ' + desc + '.', data: items };
    },
    async cancelar_agendamento(businessId, { clienteNome, hora, data }) {
      const cliente = await db.findCustomerByName(businessId, clienteNome);
      if (!cliente) return { ok: false, mensagem: 'Não encontrei o cliente "' + clienteNome + '".' };
      const apt = await db.findActiveAppointmentByCustomer(businessId, cliente.id, { hora, data });
      if (!apt) return { ok: false, mensagem: 'Não encontrei esse agendamento.' };
      await db.updateAppointment(businessId, apt.id, { status: 'cancelado' });
      return { ok: true, mensagem: 'Agendamento de ' + cliente.nome + ' cancelado.', data: apt };
    },
    async reagendar_agendamento(businessId, { clienteNome, novaData, novaHora }) {
      const cliente = await db.findCustomerByName(businessId, clienteNome);
      if (!cliente) return { ok: false, mensagem: 'Não encontrei o cliente "' + clienteNome + '".' };
      const apt = await db.findActiveAppointmentByCustomer(businessId, cliente.id, {});
      if (!apt) return { ok: false, mensagem: 'Não encontrei um agendamento ativo pra reagendar.' };
      const updated = await db.updateAppointment(businessId, apt.id, { data: novaData || apt.data, hora: novaHora || apt.hora });
      return { ok: true, mensagem: 'Agendamento de ' + cliente.nome + ' movido para ' + fmtData(updated.data) + ' às ' + updated.hora + '.', data: updated };
    },
 
    async consultar_servicos(businessId) {
      const items = await db.listServices(businessId);
      return { ok: true, mensagem: items.map(s => s.nome).join(', ') || 'Nenhum serviço cadastrado.', data: items };
    },
    async consultar_precos(businessId, { servicoNome }) {
      const s = await db.findServiceByName(businessId, servicoNome);
      if (!s) return { ok: false, mensagem: 'Não encontrei esse serviço.' };
      return { ok: true, mensagem: s.nome + ' custa R$ ' + s.preco + '.', data: s };
    },
 
    async criar_automacao(businessId, { label }) {
      if (!label) return { ok: false, mensagem: 'Preciso do nome da automação.' };
      const a = await db.createAutomation(businessId, { label });
      return { ok: true, mensagem: 'Automação "' + label + '" criada e ativada.', data: a };
    },
    // Nova (não existia antes) — precisa pra tela de Automações poder
    // ligar/desligar de verdade, em vez de só mudar um estado local.
    async editar_automacao(businessId, { id, changes }) {
      const a = await db.updateAutomation(businessId, id, changes || {});
      if (!a) return { ok: false, mensagem: 'Não encontrei essa automação.' };
      return { ok: true, mensagem: 'Automação atualizada.', data: a };
    },
 
    // ---- integrações externas: SIMULADAS nesta fase (nenhuma API real é chamada) ----
    async enviar_whatsapp(businessId, { clienteNome, mensagem }) {
      const cliente = await db.findCustomerByName(businessId, clienteNome);
      if (!cliente) return { ok: false, mensagem: 'Não encontrei o cliente "' + clienteNome + '".' };
      let texto = mensagem;
      if (!texto) {
        const [apt] = await db.listAppointments(businessId, { status: 'confirmado' });
        texto = apt
          ? 'Oi ' + cliente.nome + ', seu horário está confirmado para ' + fmtData(apt.data) + ' às ' + apt.hora + '.'
          : 'Oi ' + cliente.nome + ', tudo certo por aqui!';
      }
      try {
        await sendWhatsAppMessage(cliente.whatsapp, texto); // simulado — ver routes/whatsapp.js
        return { ok: true, mensagem: 'Mensagem simulada enviada para ' + cliente.nome + '.', data: { texto } };
      } catch (e) {
        return { ok: false, mensagem: 'Falha ao enviar WhatsApp: ' + e.message };
      }
    },
    async criar_cobranca_pix(businessId, { clienteNome, valor }) {
      const cliente = await db.findCustomerByName(businessId, clienteNome);
      if (!cliente) return { ok: false, mensagem: 'Não encontrei o cliente "' + clienteNome + '".' };
      const v = parseFloat(valor);
      if (isNaN(v)) return { ok: false, mensagem: 'Não entendi o valor da cobrança.' };
      const integracoes = await db.getBusinessIntegracoes(businessId);
      const mp = integracoes.mercado_pago || {};
      if (!mp.conectado || !mp.access_token) {
        return { ok: false, mensagem: 'Sua conta do Mercado Pago ainda não está conectada. Peça para o dono conectar em Integrações antes de criar cobranças.' };
      }
      try {
        const charge = await createPixCharge({ valor: v, descricao: 'Cobrança ' + cliente.nome, accessToken: mp.access_token });
        const payment = await db.createPayment(businessId, { customer_id: cliente.id, valor: v, external_id: charge.id, pix_copia_cola: charge.qr_code });
        return { ok: true, mensagem: 'Cobrança Pix de R$ ' + v + ' criada para ' + cliente.nome + '.', data: payment };
      } catch (e) {
        return { ok: false, mensagem: 'Falha ao criar cobrança Pix: ' + e.message };
      }
    },
    async consultar_pagamento(businessId, { clienteNome }) {
      const cliente = await db.findCustomerByName(businessId, clienteNome);
      if (!cliente) return { ok: false, mensagem: 'Não encontrei o cliente.' };
      const p = await db.findLatestPaymentByCustomer(businessId, cliente.id);
      if (!p) return { ok: true, mensagem: 'Nenhuma cobrança encontrada para ' + cliente.nome + '.' };
      return { ok: true, mensagem: 'Pagamento de ' + cliente.nome + ': R$ ' + p.valor + ' — ' + p.status + '.', data: p };
    }
  };
 
  /* Ações que só o owner/admin pode executar (configuração crítica da
     empresa) — checado na camada de rota (routes/actions.js), não
     aqui, porque runAction também precisa funcionar sem "papel"
     definido (ex: automações disparadas pelo próprio sistema). */
  const REQUIRES_OWNER = ['criar_automacao', 'editar_automacao'];
 
  /**
   * Ponto único de execução: registra toda ação no histórico
   * (assistant_actions, agora com user_id), venha de voz, texto ou
   * clique manual — e dispara automações que reagem à própria ação.
   */
  async function runAction(businessId, actionName, params, origem, comandoTexto, userId) {
    const fn = ACTIONS[actionName];
    let result;
    try {
      result = fn ? await fn(businessId, params || {}) : { ok: false, mensagem: 'Ação desconhecida: ' + actionName };
    } catch (e) {
      result = { ok: false, mensagem: 'Erro ao executar a ação.' };
    }
 
    await db.logAction({
      business_id: businessId, user_id: userId || null, origem: origem || 'manual', comando: comandoTexto || '',
      acao: actionName, params: params || {}, status: result.ok ? 'sucesso' : 'erro', mensagem: result.mensagem
    });
 
    if (actionName === 'criar_agendamento' && result.ok) {
      const autos = await db.listAutomations(businessId);
      const autoConfirm = autos.find(a => a.label.toLowerCase().includes('confirmação automática') && a.on);
      if (autoConfirm) {
        const r2 = await ACTIONS.enviar_whatsapp(businessId, { clienteNome: params.clienteNome, mensagem: null });
        await db.logAction({
          business_id: businessId, user_id: null, origem: 'automacao', comando: '', acao: 'enviar_whatsapp',
          params: { clienteNome: params.clienteNome }, status: r2.ok ? 'sucesso' : 'erro', mensagem: r2.mensagem
        });
      }
    }
 
    return result;
  }
 
  return { ACTIONS, runAction, REQUIRES_OWNER };
};
