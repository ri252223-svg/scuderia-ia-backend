/**
 * Suíte de linguagem natural pedida na autorização do item 2.
 *
 * IMPORTANTE — leia antes de interpretar os resultados: sem uma
 * ANTHROPIC_API_KEY real configurada, TODA chamada à IA falha por
 * design (é exatamente o fallback sendo testado) e cai no parser de
 * regras de sempre. Isso significa que os testes 1, 2, 3, 6, 8, 9, 10,
 * 11, 12 e 13 abaixo — que dependem de compreensão de linguagem
 * natural de verdade — NÃO provam que a IA entende essas frases; eles
 * só provam que o sistema não quebra e cai no fallback, que é o
 * comportamento correto SEM chave configurada. Os únicos que têm
 * resultado 100% conclusivo sem chave são o 14 (fallback) e qualquer
 * frase que o regex antigo já entendia por acaso.
 *
 * Assim que ANTHROPIC_API_KEY for configurada de verdade, rode este
 * arquivo de novo — aí sim os resultados vão refletir compreensão de
 * linguagem natural real.
 */
const BASE = 'http://localhost:3000';
const TEM_CHAVE = !!process.env.ANTHROPIC_API_KEY;
console.log(TEM_CHAVE ? '=== RODANDO COM CHAVE REAL — resultados refletem a IA de verdade ===\n'
                       : '=== SEM CHAVE CONFIGURADA — todo teste de linguagem natural vai cair no fallback; isso é ESPERADO, não uma falha do código ===\n');

async function post(path, body, token) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
  let json = null; try { json = await r.json(); } catch(e){}
  return { status: r.status, json };
}

async function run() {
  const email = 'ia.natural.' + Date.now() + '@teste.com';
  let r = await post('/auth/signup', { nome: 'Dona IA', email, senha: '123456' });
  const token = r.json.token;
  console.log('Conta de teste criada:', r.json.ok, '\n');

  await post('/api/actions/criar_cliente', { nome: 'João' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Maria' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Carlos' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Ana' }, token);
  await post('/api/actions/criar_servico', { nome: 'Corte', preco: 50, duracao_min: 30 }, token);

  const casos = [
    { n: 1, texto: 'Agenda o João amanhã às três.' },
    { n: 2, texto: 'Consegue encaixar a Maria amanhã às 15?' },
    { n: 3, texto: 'Vê se tem algum horário pro Carlos sexta de manhã.' },
    { n: 4, texto: 'Cancela o horário da Ana amanhã.' },
    { n: 5, texto: 'Reagenda o João para sexta às 10.' },
    { n: 6, texto: 'Manda uma mensagem pro Carlos dizendo que vou chegar atrasado.' },
    { n: 7, texto: 'Agenda a Maria amanhã às 15 e manda uma confirmação pra ela.' },
    { n: 8, texto: 'agenda o joao amanha as 3 hr, ele e cliente novo', obs: 'erro de português proposital' },
    { n: 9, texto: 'oloco marca aí o carlos amanha 3 da tarde vlw', obs: 'frase informal/gíria' },
    { n: 10, texto: 'Agenda o João.', obs: 'incompleta — sem data/hora, deveria perguntar' },
    { n: 11, texto: 'Agenda o João amanhã às 15h.', obs: 'ambígua se houver 2 João — testado à parte com dados propositalmente duplicados' },
    { n: 13, texto: 'Bom dia! Obrigado por ajudar ontem.', obs: 'não deveria chamar nenhuma ferramenta' },
  ];

  for (const c of casos) {
    const resp = await post('/api/actions/comando', { texto: c.texto, origem: 'texto' }, token);
    console.log('#' + c.n + ' "' + c.texto + '"' + (c.obs ? ' [' + c.obs + ']' : ''));
    console.log('   ->', JSON.stringify(resp.json));
    console.log('');
  }

  // 11 (versão conclusiva): ambiguidade de verdade, com 2 clientes reais "Pedro"
  await post('/api/actions/criar_cliente', { nome: 'Pedro Alves' }, token);
  await post('/api/actions/criar_cliente', { nome: 'Pedro Souza' }, token);
  const amb = await post('/api/actions/comando', { texto: 'Agenda o Pedro amanhã às 15h.', origem: 'texto' }, token);
  console.log('#11b (ambiguidade real, 2 "Pedro" cadastrados) -> ', JSON.stringify(amb.json));
  if (TEM_CHAVE) {
    console.log('   Esperado com IA real: pedir esclarecimento, listando os 2 Pedros.');
  } else {
    console.log('   Sem chave: cai no fallback de regras, que não detecta ambiguidade (comportamento pré-IA, esperado).');
  }
  console.log('');

  // 12: conversa com contexto em 2 mensagens (só é conclusivo com chave real)
  const p1 = await post('/api/actions/comando', { texto: 'Agenda o Pedro amanhã às 15h.', origem: 'texto' }, token);
  console.log('#12 (contexto) 1ª mensagem -> ', JSON.stringify(p1.json));
  const p2 = await post('/api/actions/comando', { texto: 'O Pedro Alves.', origem: 'texto' }, token);
  console.log('#12 (contexto) 2ª mensagem -> ', JSON.stringify(p2.json));
  console.log(TEM_CHAVE ? '   Esperado: a 2ª mensagem resolve a ambiguidade da 1ª usando o histórico.' : '   Sem chave: não há IA nem contexto ativo nesta chamada — só mostra que nada quebra.');
  console.log('');

  // 14: falha da API -> fallback (isso É totalmente conclusivo mesmo sem chave real,
  // porque SEM chave a "falha" é garantida e genuína, não simulada)
  const r14 = await post('/api/actions/comando', { texto: 'Cadastre a Fernanda como cliente.', origem: 'texto' }, token);
  console.log('#14 (falha de API -> fallback) -> ', JSON.stringify(r14.json));
  console.log('   Este teste É conclusivo mesmo sem chave: a chamada à IA falhou de verdade (sem key configurada) e o parser de regras assumiu — veja o log do servidor: "[IA] indisponível, usando fallback de regras".');

  process.exit(0);
}
run().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
