/**
 * Fase de IA — item 2: a integração de verdade com um modelo de
 * linguagem, via tool/function calling.
 *
 * Este módulo NUNCA toca no banco diretamente e NUNCA executa uma ação
 * que muda dado — ele só decide QUAL ferramenta usar e com quais
 * argumentos (a partir do texto do empresário), e devolve isso pronto
 * no formato que o resto do sistema (routes/actions.js → runAction →
 * lib/db.js) já sabe processar. A permissão, a confirmação e a escrita
 * no Postgres continuam exatamente onde já estavam.
 *
 * Chamado por lib/ai.js::tentarCamadaDeIA(), que captura qualquer erro
 * daqui e devolve null — fazendo resolveIntent() cair no parser de
 * regras de sempre. Este arquivo pode (e deve) lançar exceção livremente
 * em qualquer cenário de falha; a rede de segurança já existe fora dele.
 */

const { TOOLS, MUTATING_ACTIONS, NAME_RESOLVERS } = require('./aiTools');
// Mesma lista de ferramentas, só que marcada pro cache da API — as 19
// definições são idênticas em toda chamada, então cachear evita
// reprocessar esse bloco (o mais pesado do pedido) toda vez.
const TOOLS_CACHED = TOOLS.map((t, i) =>
  i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
);

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.AI_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 600;
const MAX_TOOL_ROUNDS = 4;       // limite de idas-e-voltas de ferramenta por mensagem (evita custo/loop infinito)
const REQUEST_TIMEOUT_MS = 15000; // acima disso, desiste e cai no fallback

/* Ações mutantes que recebem um cliente por nome — recebem uma checagem
   extra de ambiguidade (via db.listCustomersByName) antes de virar uma
   chain, mesmo que o modelo não tenha chamado buscar_clientes sozinho.
   Isso é uma rede de segurança no CÓDIGO, não só uma instrução de
   prompt — "não escolha um cliente errado" não pode depender só do
   modelo se comportar bem. */
const CLIENT_NAME_FIELD = {
  criar_agendamento: 'clienteNome',
  cancelar_agendamento: 'clienteNome',
  reagendar_agendamento: 'clienteNome',
  enviar_whatsapp: 'clienteNome',
  criar_cobranca_pix: 'clienteNome',
  editar_cliente: 'clienteNome'
};

/* =====================================================================
   Contexto mínimo de conversa (item 2 pede só o necessário, não uma
   memória de longo prazo). Guarda as últimas trocas em memória do
   processo, por empresa+usuário, com expiração curta — o suficiente
   pra "Qual João?" → "O João da Silva" funcionar, sem criar tabela
   nova nem tocar no Postgres (fora do escopo autorizado agora).
   ===================================================================== */
const CONTEXT_TTL_MS = 15 * 60 * 1000;
const CONTEXT_MAX_MESSAGES = 8; // últimas 4 trocas (usuário+assistente)
const contextStore = new Map();

function contextKey(businessId, userId) { return businessId + ':' + (userId || 'anon'); }
function getContext(businessId, userId) {
  const entry = contextStore.get(contextKey(businessId, userId));
  if (!entry) return [];
  if (Date.now() - entry.ultimaAtividade > CONTEXT_TTL_MS) { contextStore.delete(contextKey(businessId, userId)); return []; }
  return entry.mensagens;
}
function pushContext(businessId, userId, textoUsuario, textoResposta) {
  const key = contextKey(businessId, userId);
  const entry = contextStore.get(key) || { mensagens: [] };
  entry.mensagens.push({ role: 'user', content: textoUsuario });
  entry.mensagens.push({ role: 'assistant', content: textoResposta });
  while (entry.mensagens.length > CONTEXT_MAX_MESSAGES) entry.mensagens.shift();
  entry.ultimaAtividade = Date.now();
  contextStore.set(key, entry);
}
/* Exportado só pra teste/inspeção — o sistema em si nunca precisa ler
   isso de fora do módulo. */
function _debugContextSize() { return contextStore.size; }

function buildSystemPrompt(dataRef) {
  // Separado em duas partes de propósito: a de baixo (regras, identidade)
  // nunca muda de uma chamada pra outra, então fica marcada como
  // "cacheable" pela API da Anthropic — evita reprocessar o mesmo texto
  // longo em toda mensagem, o que deixa a resposta mais rápida. Só a
  // data de hoje muda (uma vez por dia), por isso fica separada, numa
  // parte pequena e não cacheada.
  const estatica = [
    'Você é a Siky, uma assistente de IA para empresários (donos de salões, barbearias, clínicas, oficinas e prestadores de serviço em geral) que ajuda a gerenciar clientes, agenda, serviços e cobranças através de conversa em linguagem natural — o empresário nunca precisa aprender comandos, só falar como fala normalmente.',
    '',
    'Nos argumentos das ferramentas, datas sempre em AAAA-MM-DD e horários sempre em HH:MM (24h).',
    '',
    'Regras:',
    '- Se essa for a primeira mensagem da conversa e for só um cumprimento (oi, bom dia, tudo bem etc.), responda exatamente com: "Olá! 👋\\nEu sou a Siky, sua assistente de IA.\\nO que posso fazer por você hoje?" — sem chamar ferramenta nenhuma.',
    '- Só chame uma ferramenta quando tiver certeza da intenção e de todas as informações necessárias.',
    '- Se faltar alguma informação essencial (data, horário, conteúdo de uma mensagem a enviar, etc.), não invente nada — responda em texto perguntando o que falta, sem chamar ferramenta nenhuma.',
    '- Se houver qualquer chance de existir mais de um cliente com o mesmo nome, use a ferramenta buscar_clientes antes de agir sobre ele. Se ela devolver mais de um resultado, não escolha sozinho — pergunte qual, listando as opções que encontrou.',
    '- Se a mensagem for só conversa (cumprimento, agradecimento, pergunta genérica que nenhuma ferramenta resolve), responda naturalmente em texto, sem chamar ferramenta.',
    '- Um pedido pode ter mais de uma intenção ao mesmo tempo (ex.: "agenda a Maria e avisa ela") — nesse caso, chame todas as ferramentas necessárias.',
    '- Você nunca executa nada nem acessa banco de dados diretamente — só escolhe a ferramenta certa e os argumentos. Quem executa de fato é o sistema, depois de validar permissões; algumas ações pedem confirmação do empresário antes de acontecerem de verdade, isso é tratado fora do seu alcance.',
    '- Nunca inclua business_id, user_id, id de banco ou qualquer identificador técnico nos argumentos — você não tem acesso a isso e não deve inventar.',
    '- Seja direta e natural nas respostas em texto, como alguém que realmente ajuda esse empresário no dia a dia — sem soar robótica ou repetir jargão de sistema.'
  ].join('\n');
  const dinamica = 'Hoje é ' + dataRef + '. Use isso como referência para calcular datas relativas ("amanhã", "sexta", "semana que vem" etc.).';
  return [estatica, dinamica];
}

/* Chama a API em modo streaming e RECONSTRÓI o mesmo formato de sempre
   (content: [...blocks]) — o resto do código (loop de ferramentas)
   continua funcionando exatamente igual, sem saber que veio de um
   stream. Só repassa texto ao vivo (onTextDelta) quando o PRIMEIRO
   bloco da resposta é texto puro — se a rodada vira uma chamada de
   ferramenta, nada é repassado ao vivo (é decisão interna, não deve
   aparecer pro usuário como se fosse a resposta final). */
async function callAnthropic(apiKey, systemParts, messages, onTextDelta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const system = [
    { type: 'text', text: systemParts[0], cache_control: { type: 'ephemeral' } },
    { type: 'text', text: systemParts[1] }
  ];
  let resp;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, tools: TOOLS_CACHED, messages, stream: true }),
      signal: controller.signal
    });
  } catch (e) {
    throw new Error('Falha de rede ao chamar a API do modelo: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => '');
    throw new Error('API do modelo respondeu ' + resp.status + ': ' + corpo.slice(0, 300));
  }
  if (!resp.body) throw new Error('Resposta da API sem corpo de stream.');

  const blocks = [];
  let firstBlockType = null;
  let stopReason = null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (evt.type === 'content_block_start') {
          const idx = evt.index;
          blocks[idx] = evt.content_block.type === 'tool_use'
            ? { type: 'tool_use', id: evt.content_block.id, name: evt.content_block.name, inputJson: '' }
            : { type: 'text', text: '' };
          if (firstBlockType === null) firstBlockType = blocks[idx].type;
        } else if (evt.type === 'content_block_delta' && blocks[evt.index]) {
          const b = blocks[evt.index];
          if (evt.delta.type === 'text_delta') {
            b.text += evt.delta.text;
            if (firstBlockType === 'text' && evt.index === 0 && onTextDelta) onTextDelta(evt.delta.text);
          } else if (evt.delta.type === 'input_json_delta') {
            b.inputJson += evt.delta.partial_json;
          }
        } else if (evt.type === 'message_delta' && evt.delta && evt.delta.stop_reason) {
          stopReason = evt.delta.stop_reason;
        } else if (evt.type === 'error') {
          throw new Error('API do modelo (stream): ' + (evt.error && evt.error.message || 'erro desconhecido'));
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }

  const content = blocks.filter(Boolean).map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    let input = {};
    try { input = b.inputJson ? JSON.parse(b.inputJson) : {}; } catch (e) { input = {}; }
    return { type: 'tool_use', id: b.id, name: b.name, input };
  });
  if (content.length === 0) throw new Error('Resposta da API em formato inesperado (stream vazio).');
  return { content, stop_reason: stopReason };
}

/* Resolve um tool_use mutante numa entrada de chain — ou sinaliza que
   precisa de esclarecimento (ambiguidade / não encontrado) em vez de
   adivinhar. Nunca lê nem escreve nada além das buscas por nome que as
   próprias ações já faziam. */
async function resolveChainEntry(toolUse, contexto) {
  const { name, input } = toolUse;
  const { db } = contexto;

  const clientField = CLIENT_NAME_FIELD[name];
  if (clientField && input[clientField]) {
    const matches = await db.listCustomersByName(contexto.businessId, input[clientField]);
    if (matches.length > 1) {
      return { ambiguous: 'Encontrei mais de um cliente chamado "' + input[clientField] + '": ' +
        matches.map(m => m.nome + (m.whatsapp ? ' (' + m.whatsapp + ')' : '')).join(', ') + '. Qual deles?' };
    }
    if (matches.length === 0) {
      return { notFound: 'Não encontrei nenhum cliente chamado "' + input[clientField] + '". Pode confirmar o nome?' };
    }
  }

  const resolver = NAME_RESOLVERS[name];
  if (!resolver) return { entry: { acao: name, params: input } };

  const nome = input[resolver.nameParam];
  const found = await resolver.find(db, contexto.businessId, nome);
  if (!found) return { notFound: 'Não encontrei ' + resolver.entidade + ' "' + nome + '". Pode confirmar o nome?' };
  return { entry: { acao: name, params: { id: found.id, changes: resolver.changes(input) } } };
}

async function executeReadonlyTool(toolUse, contexto) {
  const { name, input } = toolUse;
  if (name === 'buscar_clientes') {
    const matches = await contexto.db.listCustomersByName(contexto.businessId, input.nome);
    return { ok: true, resultados: matches.map(m => ({ nome: m.nome, whatsapp: m.whatsapp || null })) };
  }
  // as outras ferramentas de consulta já são ações reais — reaproveita
  // runAction (mesma validação, mesmo log de auditoria), não duplica lógica.
  return contexto.runAction(contexto.businessId, name, input, 'ia_consulta', '', contexto.userId);
}

/**
 * Ponto de entrada chamado por lib/ai.js::tentarCamadaDeIA().
 * contexto = { businessId, userId, role, runAction, db }
 * Devolve { chain, resposta } — chain é null quando a resposta é só
 * texto (conversa, pergunta, esclarecimento). Lança exceção em
 * qualquer falha, de propósito — quem chama decide o fallback.
 */
async function callAgent(texto, contexto, onTextDelta) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada.');
  if (!contexto || !contexto.businessId || !contexto.db || !contexto.runAction) {
    throw new Error('Contexto incompleto para a camada de IA.');
  }

  const hoje = new Date();
  const dias = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const dataRef = hoje.toISOString().slice(0, 10) + ' (' + dias[hoje.getDay()] + ')';
  const system = buildSystemPrompt(dataRef);

  const historico = getContext(contexto.businessId, contexto.userId);
  let messages = [...historico, { role: 'user', content: texto }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await callAnthropic(apiKey, system, messages, onTextDelta);
    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    const textoResp = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    if (toolUses.length === 0) {
      const resposta = textoResp || 'Certo!';
      pushContext(contexto.businessId, contexto.userId, texto, resposta);
      return { chain: null, resposta };
    }

    const mutantes = toolUses.filter(t => MUTATING_ACTIONS.includes(t.name));
    if (mutantes.length > 0) {
      const chain = [];
      let esclarecimento = null;
      for (const tu of mutantes) {
        const r = await resolveChainEntry(tu, contexto);
        if (r.ambiguous) { esclarecimento = r.ambiguous; break; }
        if (r.notFound) { esclarecimento = r.notFound; break; }
        chain.push(r.entry);
      }
      if (esclarecimento) {
        pushContext(contexto.businessId, contexto.userId, texto, esclarecimento);
        return { chain: null, resposta: esclarecimento };
      }
      pushContext(contexto.businessId, contexto.userId, texto, '[ação proposta: ' + chain.map(c => c.acao).join(', ') + ']');
      return { chain };
    }

    // só ferramentas de leitura nesta rodada — executa de verdade e
    // devolve o resultado pro modelo decidir o próximo passo.
    const toolResultBlocks = [];
    for (const tu of toolUses) {
      let resultado;
      try {
        resultado = await executeReadonlyTool(tu, contexto);
      } catch (e) {
        resultado = { ok: false, mensagem: 'Erro ao consultar.' };
      }
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(resultado) });
    }
    messages = [...messages, { role: 'assistant', content: resp.content }, { role: 'user', content: toolResultBlocks }];
  }

  throw new Error('Excedeu o número máximo de passos de raciocínio (' + MAX_TOOL_ROUNDS + ').');
}

module.exports = { callAgent, buildSystemPrompt, _debugContextSize };
