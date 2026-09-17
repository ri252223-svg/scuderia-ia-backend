/**
 * Testes do MOTOR do agente (lib/agent.js) usando respostas SIMULADAS
 * da API da Anthropic — sem chave real, não dá pra testar se o modelo
 * "entende" linguagem natural de verdade, mas dá pra provar que todo o
 * encanamento em volta dele (resolver nome->id, detectar ambiguidade,
 * montar chain composta, alternar leitura/escrita, contexto) está
 * correto, simulando exatamente o formato que a API seria esperada
 * devolver em cada cenário.
 */
process.env.ANTHROPIC_API_KEY = 'chave-fake-para-teste';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://scuderia:scuderia_dev_pw@localhost:5432/scuderia_ia';

let passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; console.log('✅ ' + label); }
  else { failed++; console.log('❌ ' + label + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}

// mock simples de banco — só o suficiente pro agente funcionar sem Postgres de verdade
function makeMockDb(customers) {
  return {
    async listCustomersByName(businessId, nome) {
      return customers.filter(c => c.nome.toLowerCase().includes(nome.toLowerCase()));
    },
    async findCustomerByName(businessId, nome) {
      const m = customers.filter(c => c.nome.toLowerCase().includes(nome.toLowerCase()));
      return m[0] || null;
    },
    async findServiceByName() { return null; },
    async findProfessionalByName() { return null; }
  };
}
function makeMockRunAction(log) {
  return async (businessId, acao, params, origem, comandoTexto, userId) => {
    log.push({ acao, params, origem });
    if (acao === 'consultar_agenda') return { ok: true, mensagem: 'Nada agendado.', data: [] };
    return { ok: true, mensagem: 'ok (mock)' };
  };
}

// intercepta fetch pra simular respostas da Anthropic sem chamar a rede de verdade
function mockFetchSequence(respostas) {
  let i = 0;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const resp = respostas[Math.min(i, respostas.length - 1)];
    i++;
    return {
      ok: true,
      json: async () => resp,
      text: async () => JSON.stringify(resp)
    };
  };
}

function toolUseMsg(name, input, id) {
  return { content: [{ type: 'tool_use', id: id || 'tu_' + Math.random().toString(36).slice(2,8), name, input }] };
}
function textMsg(text) {
  return { content: [{ type: 'text', text }] };
}

async function run() {
  delete require.cache[require.resolve('./lib/agent.js')];
  const { callAgent } = require('./lib/agent.js');

  // ---------- 1. Ferramenta simples: cria a chain corretamente ----------
  mockFetchSequence([ toolUseMsg('criar_agendamento', { clienteNome: 'João', data: '2026-09-12', hora: '15:00' }) ]);
  const db1 = makeMockDb([{ id: 'c1', nome: 'João Silva', whatsapp: '119999' }]);
  const log1 = []; const runAction1 = makeMockRunAction(log1);
  let r = await callAgent('Agenda o João amanhã às 15h', { businessId: 'b1', userId: 'u1', db: db1, runAction: runAction1 });
  check('Tool call simples vira chain com a ação certa', r.chain && r.chain[0].acao === 'criar_agendamento', r);
  check('clienteNome preservado na chain (ação resolve o cliente internamente)', r.chain && r.chain[0].params.clienteNome === 'João', r);

  // ---------- 2. Ambiguidade: 2 clientes com nome parecido ----------
  mockFetchSequence([ toolUseMsg('criar_agendamento', { clienteNome: 'João', data: '2026-09-12', hora: '15:00' }) ]);
  const db2 = makeMockDb([{ id:'c1', nome:'João Silva' }, { id:'c2', nome:'João Pereira' }]);
  r = await callAgent('Agenda o João amanhã às 15h', { businessId: 'b2', userId: 'u2', db: db2, runAction: makeMockRunAction([]) });
  check('2 "João" -> NÃO cria chain, pede esclarecimento', r.chain === null && /mais de um cliente/i.test(r.resposta), r);
  check('esclarecimento lista as opções encontradas', /João Silva/.test(r.resposta) && /João Pereira/.test(r.resposta), r);

  // ---------- 3. Cliente não encontrado ----------
  mockFetchSequence([ toolUseMsg('cancelar_agendamento', { clienteNome: 'Zeca' }) ]);
  const db3 = makeMockDb([]);
  r = await callAgent('Cancela o horário do Zeca', { businessId: 'b3', userId: 'u3', db: db3, runAction: makeMockRunAction([]) });
  check('Cliente inexistente -> pede confirmação do nome, não quebra', r.chain === null && /não encontrei/i.test(r.resposta), r);

  // ---------- 4. Comando composto: 2 tool_use na mesma resposta ----------
  mockFetchSequence([{ content: [
    { type: 'tool_use', id: 'tu1', name: 'criar_agendamento', input: { clienteNome: 'Maria', data: '2026-09-12', hora: '15:00' } },
    { type: 'tool_use', id: 'tu2', name: 'enviar_whatsapp', input: { clienteNome: 'Maria', mensagem: 'Confirmado!' } }
  ]}]);
  const db4 = makeMockDb([{ id:'c1', nome:'Maria' }]);
  r = await callAgent('Agenda a Maria amanhã às 15 e manda uma confirmação pra ela', { businessId: 'b4', userId: 'u4', db: db4, runAction: makeMockRunAction([]) });
  check('Composto: 2 ações na MESMA chain, sem regex de split', r.chain && r.chain.length === 2, r);
  check('Composto: ordem preservada (agendar, depois avisar)', r.chain && r.chain[0].acao === 'criar_agendamento' && r.chain[1].acao === 'enviar_whatsapp', r);

  // ---------- 5. Conversa comum -> sem chain, resposta em texto ----------
  mockFetchSequence([ textMsg('Oi! Tudo ótimo por aqui, como posso ajudar?') ]);
  r = await callAgent('Oi Scuderia, tudo bem?', { businessId: 'b5', userId: 'u5', db: makeMockDb([]), runAction: makeMockRunAction([]) });
  check('Conversa casual -> nenhuma ferramenta chamada', r.chain === null && r.resposta.length > 0, r);

  // ---------- 6. Ferramenta de leitura no meio do raciocínio (loop de 2 rodadas) ----------
  const log6 = [];
  mockFetchSequence([
    toolUseMsg('consultar_agenda', { data: '2026-09-12' }),
    textMsg('Amanhã sua agenda está livre!')
  ]);
  r = await callAgent('Como está minha agenda amanhã?', { businessId: 'b6', userId: 'u6', db: makeMockDb([]), runAction: makeMockRunAction(log6) });
  check('Consulta de leitura É executada de verdade (via runAction)', log6.length === 1 && log6[0].acao === 'consultar_agenda', log6);
  check('Depois da consulta, modelo responde em texto (2ª rodada)', r.chain === null && /livre/i.test(r.resposta), r);

  // ---------- 7. Resolução de nome->id (ação com NAME_RESOLVER) ----------
  mockFetchSequence([ toolUseMsg('editar_cliente', { clienteNome: 'João', novoWhatsapp: '11988887777' }) ]);
  const db7 = makeMockDb([{ id: 'cid-123', nome: 'João Silva' }]);
  r = await callAgent('Muda o whatsapp do João pra 11988887777', { businessId: 'b7', userId: 'u7', db: db7, runAction: makeMockRunAction([]) });
  check('editar_cliente: nome resolvido pra id de verdade na chain', r.chain && r.chain[0].params.id === 'cid-123', r);
  check('editar_cliente: changes montado a partir do novoWhatsapp', r.chain && r.chain[0].params.changes.whatsapp === '11988887777', r);

  // ---------- 8. Contexto entre 2 mensagens ----------
  mockFetchSequence([ textMsg('Encontrei mais de um João. Qual deles — o da Silva ou o da Pereira?') ]);
  await callAgent('Agenda o João amanhã às 15h', { businessId: 'b8', userId: 'u8', db: makeMockDb([]), runAction: makeMockRunAction([]) });
  // 2ª chamada: o mock só verifica que o histórico foi incluído no corpo da requisição
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => toolUseMsg('criar_agendamento', { clienteNome: 'João da Silva', data: '2026-09-12', hora: '15:00' }) };
  };
  await callAgent('O João da Silva', { businessId: 'b8', userId: 'u8', db: makeMockDb([{id:'c1',nome:'João da Silva'}]), runAction: makeMockRunAction([]) });
  check('2ª mensagem envia o histórico da 1ª pro modelo (contexto)', capturedBody && capturedBody.messages.length >= 3, capturedBody && capturedBody.messages);

  // ---------- 9. Falha de API -> lança exceção (pra resolveIntent cair no fallback) ----------
  global.fetch = async () => { throw new Error('network down'); };
  let threw = false;
  try { await callAgent('Agenda o João amanhã às 15h', { businessId: 'b9', userId: 'u9', db: makeMockDb([]), runAction: makeMockRunAction([]) }); }
  catch (e) { threw = true; }
  check('Falha de rede -> callAgent lança exceção (não trava silenciosamente)', threw);

  // ---------- 10. Sem API key -> lança exceção clara ----------
  delete process.env.ANTHROPIC_API_KEY;
  delete require.cache[require.resolve('./lib/agent.js')];
  const { callAgent: callAgent2 } = require('./lib/agent.js');
  let threw2 = false, msg2 = '';
  try { await callAgent2('oi', { businessId:'b10', userId:'u10', db: makeMockDb([]), runAction: makeMockRunAction([]) }); }
  catch(e) { threw2 = true; msg2 = e.message; }
  check('Sem ANTHROPIC_API_KEY -> lança erro claro', threw2 && /API_KEY/.test(msg2), msg2);

  console.log('\n--- RESUMO (motor do agente, respostas simuladas) ---');
  console.log(passed + ' passaram, ' + failed + ' falharam');
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
