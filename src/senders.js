import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { FalhaServico } from './eventos.js';

const BC_API = process.env.BOTCONVERSA_API_URL || 'https://backend.botconversa.com.br/api/v1/webhook';

// falhas de rede em que o pedido certamente NÃO chegou ao servidor: é seguro repetir (sem risco de mensagem duplicada)
const ANTES_DE_CHEGAR = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url, body, headers = {}) {
  let res;
  for (let tentativa = 1; ; tentativa++) {
    try {
      res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      break;
    } catch (e) {
      const code = e.cause?.code || e.cause?.name || e.name;
      // GET pode sempre ser repetido; POST só se o pedido não saiu daqui
      if (tentativa < 4 && (method === 'GET' || ANTES_DE_CHEGAR.has(code))) { await sleep(3000 * tentativa); continue; }
      const err = new Error(`sem conexão (${code || e.message})${tentativa > 1 ? ` após ${tentativa} tentativas` : ''}`);
      err.rede = true; err.code = code;
      throw err;
    }
  }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const corpo = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
    const err = new Error(`HTTP ${res.status} ${corpo}`);
    err.status = res.status; err.corpo = corpo;
    throw err;
  }
  return data;
}

/** Explica em português o que deu errado numa chamada */
function motivo(e) {
  if (e.rede) return e.message;
  if (e.status === 401 || e.status === 403) return `acesso negado (HTTP ${e.status}) — confira a chave de API`;
  if (e.status === 404) return 'não encontrado (HTTP 404)';
  if (e.status === 429) return 'limite de envios atingido (HTTP 429) — tente mais tarde';
  if (e.status >= 500) return `serviço fora do ar (HTTP ${e.status})`;
  if (e.status) return `recusado (HTTP ${e.status})`;
  return e.message;
}
/** Executa uma etapa e, se falhar, diz em qual serviço/etapa foi */
async function etapa(servico, nome, fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof FalhaServico) throw e;
    // Botconversa recusando o número = problema do WhatsApp do contato, não do Botconversa
    const numero = servico === 'botconversa' && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403
      && /phone|telefone|whats|n[uú]mero|number|inv[aá]lid/i.test(e.corpo || '');
    throw new FalhaServico(numero ? 'whatsapp' : servico, nome, numero ? 'número recusado (sem WhatsApp ou inválido)' : motivo(e), e.corpo || e.code || '');
  }
}

const bc = (method, path, body) => http(method, BC_API + path, body, { 'API-KEY': config.botconversa.apiKey });

/** "2026-11-25 13:00:00" (UTC, como o Mautic grava) → "2026-11-25 10:00:00" (horário de Brasília) */
const brasilia = (s) => {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
};

/** Dados que vão para o CRM (exatamente os campos mapeados lá) */
export function payload(p) {
  const clique = brasilia(p.ultimo_clique);
  return {
    nome_completo: [p.nome, p.sobrenome].filter(Boolean).join(' '),
    email: p.email,
    telefone: '+' + p.telefone,
    whatsapp: p.telefone,
    empresa: p.empresa,
    origem: 'Mautic - E-mail [ABRADILAN]',
    campanha: 'Remarketing Hospedagem ABRADILAN',
    email_clicado: p.email_origem,
    data_clique: clique,
    mautic_id: p.lead_id,
    observacao: `Clicou no e-mail "${p.email_origem}" em ${clique} e ainda não escolheu o pacote de hospedagem.`,
  };
}

/** Dispara o fluxo do WhatsApp pelo Botconversa. Devolve um resumo do que foi feito. */
export async function sendBotconversa(p) {
  const b = config.botconversa;
  if (b.webhookUrl) {
    await etapa('botconversa', 'Enviar ao webhook do Botconversa', () => http('POST', b.webhookUrl, { nome: p.nome, sobrenome: p.sobrenome, ...payload(p) }));
    return { resumo: 'Contato enviado ao webhook do fluxo' };
  }
  const phone = p.telefone; // só dígitos, como nos fluxos do n8n (ex.: 5511999999999)
  let sub, novo = false;
  sub = await etapa('botconversa', 'Buscar contato no Botconversa', async () => {
    try { return await bc('GET', `/subscriber/get_by_phone/${phone}/`); }
    catch (e) { if (e.status === 404) return null; throw e; }
  });
  if (!sub?.id) {
    const nome = (p.nome || '').trim().split(/\s+/);
    sub = await etapa('botconversa', 'Cadastrar contato no Botconversa', () => bc('POST', '/subscriber/', {
      phone, first_name: nome[0] || 'Cliente', last_name: (p.sobrenome || nome.slice(1).join(' ') || '.').trim(), has_opt_in_whatsapp: true,
    }));
    novo = true;
  }
  if (!sub?.id) throw new FalhaServico('botconversa', 'Cadastrar contato no Botconversa', 'o Botconversa não devolveu o id do contato');
  if (b.tagId) await bc('POST', `/subscriber/${sub.id}/tags/${b.tagId}/`).catch(() => {});
  if (b.flowId) await etapa('botconversa', `Disparar fluxo ${b.flowId}`, () => bc('POST', `/subscriber/${sub.id}/send_flow/`, { flow: Number(b.flowId) }));
  else await etapa('botconversa', 'Enviar mensagem de texto', () => bc('POST', `/subscriber/${sub.id}/send_message/`, { type: 'text', value: mensagem(p) }));
  return {
    subscriber: sub.id,
    resumo: `${b.flowId ? `Fluxo ${b.flowId} disparado` : 'Mensagem enviada'} para o contato ${sub.id} do Botconversa${novo ? ' (cadastrado agora)' : ''}`,
  };
}

/** Texto usado quando não há BOTCONVERSA_FLOW_ID (arquivo mensagem.txt, com {{nome}} e {{empresa}}) */
const MSG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mensagem.txt');
export function mensagem(p) {
  const primeiro = (p.nome || '').trim().split(/\s+/)[0] || '';
  const nome = primeiro ? primeiro[0].toUpperCase() + primeiro.slice(1).toLowerCase() : '';
  return readFileSync(MSG_FILE, 'utf8').trim()
    .replace(/\{\{\s*nome\s*\}\}/g, nome).replace(/Olá, ,/g, 'Olá,')
    .replace(/\{\{\s*empresa\s*\}\}/g, p.empresa || '');
}

/** Cria (ou atualiza) o negócio no funil do CRM */
export async function sendCrm(p) {
  const r = await etapa('crm', 'Criar negócio no funil do CRM', () => http('POST', config.crmWebhookUrl, payload(p)));
  if (r && typeof r === 'object' && r.ok === false) throw new FalhaServico('crm', 'Criar negócio no funil do CRM', 'o CRM recusou os dados', JSON.stringify(r).slice(0, 300));
  const acao = r?.action === 'updated' ? 'atualizado (o contato já existia no CRM)' : r?.action === 'created' ? 'criado' : 'enviado';
  return { ...(typeof r === 'object' ? r : {}), resumo: `Negócio ${acao}${r?.deal_id ? ` · id ${r.deal_id}` : ''}` };
}

export async function listBotconversa() {
  const [flows, tags] = await Promise.all([bc('GET', '/flows/'), bc('GET', '/tags/').catch(() => [])]);
  return { flows, tags };
}
