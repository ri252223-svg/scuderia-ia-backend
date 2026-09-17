/**
 * Camada de IA — interpreta o texto (transcrito da voz ou digitado) e
 * escolhe qual ação controlada chamar. É a MESMA lógica usada no
 * protótipo do frontend, portada pro servidor: dessa forma, voz e
 * texto batem no mesmo lugar, e o webhook do WhatsApp usa exatamente
 * este mesmo interpretador para o que o cliente escreve.
 *
 * Hoje é baseada em regras (regex). Está isolada nesta função para
 * poder virar uma chamada a um serviço de NLU/LLM depois, mantendo o
 * mesmo contrato de retorno: { acao, params }.
 */

function normalize(str) {
  return (str || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function trimEnd(s) { return (s || '').replace(/[.!?]+$/, '').trim(); }
function titleCase(s) { return (s || '').split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }
function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
function isoDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function parseSpokenDate(str) {
  const n = normalize(str);
  const today = new Date();
  if (n.includes('hoje')) return isoDate(today);
  if (n.includes('amanha')) { const d = new Date(today); d.setDate(d.getDate() + 1); return isoDate(d); }
  const dias = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  for (let i = 0; i < dias.length; i++) {
    if (n.includes(dias[i])) {
      const d = new Date(today);
      const diff = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return isoDate(d);
    }
  }
  const m = n.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (m) { const d = new Date(today.getFullYear(), parseInt(m[2]) - 1, parseInt(m[1])); return isoDate(d); }
  return isoDate(today);
}
function parseSpokenTime(str) {
  const n = normalize(str);
  let m = n.match(/(\d{1,2})[:h](\d{2})/); if (m) return pad2(m[1]) + ':' + m[2];
  m = n.match(/(\d{1,2})\s*h(oras)?/); if (m) return pad2(m[1]) + ':00';
  return null;
}

const AI_COMMANDS = [
  { acao: 'criar_cliente', re: /^cadastr(?:e|a)\s+(?:o|a)?\s*(.+?)\s+como\s+cliente/,
    map: (m) => ({ nome: titleCase(trimEnd(m[1])) }) },
  { acao: 'buscar_cliente', re: /^(?:busca|buscar|procura|procurar)\s+(?:o|a)?\s*cliente\s+(.+)/,
    map: (m) => ({ nome: trimEnd(m[1]) }) },
  { acao: 'criar_agendamento', re: /^agend(?:e|a)\s+(?:o|a)?\s*(.+?)\s+(?:para\s+)?(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}[\/\-]\d{1,2})\s+(?:as|às)\s+(.+)/,
    map: (m) => ({ clienteNome: titleCase(trimEnd(m[1])), data: parseSpokenDate(m[2]), hora: parseSpokenTime(m[3]) }) },
  { acao: 'consultar_agenda', re: /^quem\s+(?:eu\s+)?tenho\s*(hoje|amanha)?/,
    map: (m) => ({ data: m[1] ? parseSpokenDate(m[1]) : isoDate(new Date()) }) },
  { acao: 'consultar_agenda', re: /^(?:mostra|mostrar|ver|consulta|consultar)\s+(?:a\s+)?agenda\s*(?:de\s+)?(hoje|amanha)?/,
    map: (m) => ({ data: m[1] ? parseSpokenDate(m[1]) : isoDate(new Date()) }) },
  { acao: 'cancelar_agendamento', re: /^cancel(?:e|a)\s+(?:o\s+)?(?:horario\s+d[eoa]\s+)?(.+?)(?:\s+d[ae]s?\s+(.+))?$/,
    map: (m) => ({ clienteNome: titleCase(trimEnd(m[1])), hora: m[2] ? parseSpokenTime(m[2]) : null }) },
  { acao: 'reagendar_agendamento', re: /^reagend(?:e|a)\s+(?:o\s+)?(.+?)\s+para\s+(hoje|amanha|\d{1,2}[\/\-]\d{1,2})\s+(?:as|às)\s+(.+)/,
    map: (m) => ({ clienteNome: titleCase(trimEnd(m[1])), novaData: parseSpokenDate(m[2]), novaHora: parseSpokenTime(m[3]) }) },
  { acao: 'consultar_servicos', re: /^(?:quais|mostra|mostrar|ver)\s+(?:os\s+)?servicos/, map: () => ({}) },
  { acao: 'consultar_precos', re: /^(?:quanto\s+custa|qual\s+o\s+preco\s+d[eoa])\s+(.+)/,
    map: (m) => ({ servicoNome: trimEnd(m[1]) }) },
  { acao: 'criar_automacao', re: /^cri(?:e|a)\s+(?:uma\s+)?automacao\s+(?:de\s+|para\s+)?(.+)/,
    map: (m) => ({ label: titleCase(trimEnd(m[1])) }) },
  { acao: 'enviar_whatsapp', re: /^manda(?:r)?\s+(?:uma\s+)?mensagem\s+(?:para|pra)\s+(?:o|a)?\s*(.+?)\s+dizendo\s+(?:que\s+)?(.+)/,
    map: (m) => ({ clienteNome: titleCase(trimEnd(m[1])), mensagem: capFirst(trimEnd(m[2])) }) },
  { acao: 'enviar_whatsapp', re: /^manda(?:r)?\s+(?:uma\s+)?confirmacao\s+(?:para|pra)\s+(?:o|a)?\s*(.+)/,
    map: (m) => ({ clienteNome: trimEnd(m[1]), mensagem: null }) },
  { acao: 'criar_cobranca_pix', re: /^cobr(?:e|a)(?:r)?\s+(?:o|a)?\s*(.+?)\s+em\s+(?:r\$)?\s*(\d+(?:[.,]\d+)?)\s*(?:reais)?/,
    map: (m) => ({ clienteNome: titleCase(trimEnd(m[1])), valor: parseFloat(m[2].replace(',', '.')) }) },
  { acao: 'consultar_pagamento', re: /^pagamento\s+d[eoa]\s+(.+)/,
    map: (m) => ({ clienteNome: titleCase(trimEnd(m[1]).replace(/\s*(ja\s+)?(caiu|confirmado)\s*$/, '')) }) }
];

const CONFIRM_REQUIRED = ['criar_agendamento', 'cancelar_agendamento', 'reagendar_agendamento', 'enviar_whatsapp', 'criar_cobranca_pix'];
const PRONOUNS = ['ela', 'ele', 'dele', 'dela'];

function parseCommand(raw) {
  const norm = normalize((raw || '').trim());
  for (const cmd of AI_COMMANDS) {
    const m = cmd.re.exec(norm);
    if (m) return { acao: cmd.acao, params: cmd.map(m) };
  }
  return null;
}

/** Comandos compostos ("agenda X e manda confirmação pra ela") viram uma cadeia de 2 ações. */
function parseCommandChain(raw) {
  const direct = parseCommand(raw);
  if (direct) return [direct];
  const parts = (raw || '').split(/\s+e\s+/i);
  if (parts.length >= 2) {
    const first = parseCommand(parts[0]);
    const second = parseCommand(parts.slice(1).join(' e '));
    if (first && second) {
      resolvePronoun(first, second);
      return [first, second];
    }
  }
  return null;
}
function resolvePronoun(first, second) {
  if (second.acao === 'enviar_whatsapp') {
    const nome = second.params.clienteNome;
    if (!nome || PRONOUNS.includes(normalize(nome))) {
      const refNome = first.params.clienteNome || first.params.nome;
      if (refNome) second.params.clienteNome = refNome;
    }
  }
}

/* =====================================================================
   FASE DE IA — ITEM 1 (arquitetura de fallback)
   =====================================================================
   Esta seção NÃO interpreta nada sozinha ainda. Ela só formaliza o
   encaixe onde a camada de inteligência de linguagem natural vai
   entrar nas próximas etapas (autorização pendente para os itens 2+),
   sem mexer em uma linha sequer do parser acima.

   Contrato:
     resolveIntent(texto, contexto) → Promise<{ chain, fonte }>
       chain: exatamente o que parseCommandChain já devolvia — um
              array de { acao, params } ou null. routes/actions.js
              não precisa saber se veio da IA ou do regex.
       fonte: 'ia' | 'fallback_regras' — só para log/observabilidade
              futura; nada no sistema depende deste campo hoje.

   Fluxo:
     resolveIntent → tenta a camada de IA (tentarCamadaDeIA)
                   → se ela devolver algo, usa
                   → se devolver null (hoje, SEMPRE devolve null —
                     a integração real ainda não foi autorizada),
                     cai no parseCommandChain de sempre, sem nenhuma
                     mudança de comportamento observável.

   Quando o item 2 for autorizado, só o CORPO de tentarCamadaDeIA
   muda (passa a chamar o modelo de verdade) — a assinatura, o
   contrato de retorno e todo o resto do arquivo continuam iguais.
   ===================================================================== */

const { callAgent } = require('./agent');

/**
 * Fase de IA, item 2: chama o agente de verdade (lib/agent.js, que
 * fala com o modelo de linguagem via tool calling). Qualquer falha —
 * timeout, erro de API, JSON inválido, ferramenta desconhecida, chave
 * não configurada, contexto incompleto — é capturada AQUI e vira null,
 * fazendo resolveIntent cair no parser de regras de sempre. A Scuderia
 * nunca "trava" por causa da camada de IA.
 */
async function tentarCamadaDeIA(texto, contexto, onTextDelta) {
  try {
    return await callAgent(texto, contexto, onTextDelta);
  } catch (e) {
    console.error('[IA] indisponível, usando fallback de regras:', e.message);
    return null;
  }
}

/**
 * Ponto de entrada único para interpretar uma mensagem do empresário
 * (voz ou texto — quem chama já normalizou pra texto antes disso).
 * routes/actions.js deve chamar esta função no lugar de
 * parseCommandChain diretamente — o parser continua existindo e
 * funcionando do mesmo jeito, só que agora por trás desta camada.
 *
 * Contrato de retorno:
 *   { chain, fonte, resposta }
 *   chain:    array de { acao, params } prontos pro fluxo existente de
 *             permissão/confirmação/execução — ou null.
 *   fonte:    'ia' | 'fallback_regras' — só observabilidade.
 *   resposta: texto pronto da IA quando ela decidiu não chamar
 *             ferramenta nenhuma (conversa, pergunta por informação
 *             faltante, ou pedido de esclarecimento por ambiguidade).
 *             É null quando veio do fallback de regras (que não tem
 *             capacidade de responder em linguagem natural) ou quando
 *             a IA propôs uma ação (chain preenchida).
 */
async function resolveIntent(texto, contexto, onTextDelta) {
  const daIA = await tentarCamadaDeIA(texto, contexto || {}, onTextDelta);
  if (daIA) {
    console.log('[IA] respondeu o MODELO DE VERDADE (fonte=ia) para: "' + texto + '"');
    return { chain: daIA.chain, fonte: 'ia', resposta: daIA.resposta || null };
  }
  console.log('[IA] usando FALLBACK DE REGRAS (fonte=fallback_regras) para: "' + texto + '"');
  return { chain: parseCommandChain(texto), fonte: 'fallback_regras', resposta: null };
}

module.exports = { parseCommand, parseCommandChain, resolveIntent, CONFIRM_REQUIRED, normalize };
