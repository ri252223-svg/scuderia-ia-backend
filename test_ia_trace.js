/**
 * ITEM 2A — teste detalhado da inteligência real, com rastro completo
 * por cenário: entrada → interpretação → ferramenta → argumentos →
 * se houve consulta prévia → se pediu esclarecimento → se pediu
 * confirmação → resultado final.
 *
 * Precisa de ANTHROPIC_API_KEY de verdade no .env pra ter valor —
 * sem ela, todo cenário vai cair no fallback de regras (o script avisa
 * isso no topo do relatório, não esconde).
 *
 * Rodar (depois de configurar backend/.env e iniciar o servidor):
 *   node test_ia_trace.js
 */
const BASE = 'http://localhost:3000';
const TEM_CHAVE = !!process.env.ANTHROPIC_API_KEY;

async function post(path, body, token) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
  let json = null; try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}

function linha() { console.log('─'.repeat(78)); }

function relatarCenario(n, texto, obs, resp) {
  linha();
  console.log('#' + n + '  ENTRADA: "' + texto + '"' + (obs ? '  [' + obs + ']' : ''));
  console.log('    fonte da resposta: ' + (resp.json.fonte || '(não informado — resposta veio de /confirmar ou erro)'));

  if (resp.json.chain && resp.json.chain.length) {
    console.log('    ferramenta(s) escolhida(s): ' + resp.json.chain.map(c => c.acao).join(', '));
    resp.json.chain.forEach(c => console.log('      argumentos [' + c.acao + ']: ' + JSON.stringify(c.params)));
    console.log('    pediu confirmação? ' + (resp.json.needsConfirm ? 'SIM (confirmationId ' + resp.json.confirmationId + ')' : 'não (ação não sensível)'));
  } else {
    console.log('    nenhuma ferramenta chamada — resposta em texto:');
    console.log('      "' + resp.json.mensagem + '"');
    const pareceEsclarecimento = /qual|encontrei mais de um|não encontrei|pode confirmar|que hor[áa]rio|quando/i.test(resp.json.mensagem || '');
    console.log('    parece pedido de esclarecimento/pergunta? ' + (pareceEsclarecimento ? 'sim, pelo teor da resposta' : 'não — parece só conversa'));
  }
  console.log('    resultado bruto: ' + JSON.stringify(resp.json));
}

async function run() {
  console.log('='.repeat(78));
  console.log(TEM_CHAVE
    ? 'ANTHROPIC_API_KEY detectada — resultados abaixo vêm do MODELO DE VERDADE.'
    : '⚠️  SEM ANTHROPIC_API_KEY — todo cenário abaixo vai cair no fallback de\n   regras. Configure a chave em backend/.env e rode de novo pra um\n   resultado que realmente prove compreensão de linguagem natural.');
  console.log('='.repeat(78));

  const email = 'ia.trace.' + Date.now() + '@teste.com';
  let r = await post('/auth/signup', { nome: 'Dona Trace', email, senha: '123456' });
  const token = r.json.token;
  console.log('\nConta de teste: ' + (r.json.ok ? 'criada com sucesso' : 'FALHOU — ' + JSON.stringify(r.json)));

  // seed de dados — inclui um caso de ambiguidade DE VERDADE (2 Pedro) e um
  // serviço/cliente pra dar contexto real às consultas
  await post('/api/actions/criar_cliente', { nome: 'João', whatsapp: '11999990001' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Maria', whatsapp: '11999990002' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Carlos', whatsapp: '11999990003' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Ana', whatsapp: '11999990004' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Pedro Alves' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Pedro Souza' }, token);
  await post('/api/actions/criar_servico', { nome: 'Corte', preco: 50, duracao_min: 30 }, token);
  console.log('Dados de teste semeados (João, Maria, Carlos, Ana, 2x Pedro, serviço Corte).\n');

  const cenarios = [
    { n: 1, texto: 'Chat, vê aí se consegue encaixar o João amanhã no meio da tarde.', obs: 'linguagem indireta, "meio da tarde" não é regex' },
    { n: 2, texto: 'Aquele cliente Carlos que veio semana passada, manda uma mensagem falando que o horário dele foi confirmado.', obs: 'frase longa, referência indireta' },
    { n: 3, texto: 'Tem algum horário livre amanhã depois do almoço pra Maria?', obs: 'pergunta que pede CONSULTA antes de qualquer ação' },
    { n: 4, texto: 'Desmarca o horário da Ana e avisa ela que tivemos um imprevisto.', obs: 'comando composto: cancelar + notificar' },
    { n: 5, texto: 'Quero colocar o João na agenda amanhã, mas não lembro que horas tenho livre.', obs: 'informação faltando (hora) — deveria perguntar, não inventar' },
    { n: 6, texto: 'Fala pra Maria que o horário dela está confirmado.', obs: 'referência a agendamento existente' },
    { n: 7, texto: 'O Carlos consegue vir amanhã depois das três?', obs: 'pergunta ambígua entre consulta e proposta de agendamento' },
    { n: 8, texto: 'Bom dia Scuderia, como você está?', obs: 'conversa casual — NÃO deveria chamar ferramenta' },
    { n: 9, texto: 'Agenda o Pedro amanhã às 15h.', obs: 'AMBIGUIDADE REAL — existem 2 "Pedro" cadastrados' },
    { n: 10, texto: 'Agenda o Zezinho amanhã às 15h.', obs: 'cliente INEXISTENTE — não deveria inventar nem cadastrar sozinho' },
  ];

  for (const c of cenarios) {
    const resp = await post('/api/actions/comando', { texto: c.texto, origem: 'texto' }, token);
    relatarCenario(c.n, c.texto, c.obs, resp);
  }

  // conversa com contexto em 2 mensagens — retoma o cenário 9 (ambíguo) e resolve na 2ª
  linha();
  console.log('#11  CONTEXTO EM 2 MENSAGENS');
  const p1 = await post('/api/actions/comando', { texto: 'Agenda o Pedro amanhã às 16h.', origem: 'texto' }, token);
  console.log('    1ª mensagem: "Agenda o Pedro amanhã às 16h."');
  console.log('      -> ' + JSON.stringify(p1.json));
  const p2 = await post('/api/actions/comando', { texto: 'O Pedro Alves, por favor.', origem: 'texto' }, token);
  console.log('    2ª mensagem: "O Pedro Alves, por favor."');
  console.log('      -> ' + JSON.stringify(p2.json));
  console.log('    contexto funcionou? ' + (p2.json.chain && p2.json.chain[0] && /Pedro Alves/i.test(JSON.stringify(p2.json.chain)) ? 'sim, resolveu usando a 1ª mensagem' : 'inconclusivo/não — ver resultado bruto acima'));

  // confirmação de verdade — pega a última chain pendente e confirma
  if (p2.json.needsConfirm) {
    linha();
    console.log('#12  CONFIRMANDO a ação do cenário #11');
    const conf = await post('/api/actions/confirmar', { confirmationId: p2.json.confirmationId, confirmado: true }, token);
    console.log('    -> ' + JSON.stringify(conf.json));
  }

  process.exit(0);
}
run().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
