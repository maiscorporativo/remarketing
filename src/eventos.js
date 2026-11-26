/**
 * Relatório de atividades: cada ação e cada falha fica registrada no banco, com o serviço envolvido.
 *   nivel:   ok | info | aviso | erro
 *   servico: whatsapp | botconversa | crm | mautic | sistema | painel
 *   origem:  automático | manual | painel | teste | sistema
 */
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    em TEXT NOT NULL,
    nivel TEXT NOT NULL,
    servico TEXT NOT NULL,
    acao TEXT NOT NULL,
    lead_id INTEGER, contato TEXT, telefone TEXT,
    mensagem TEXT, detalhe TEXT,
    origem TEXT, lote TEXT
  );
  CREATE INDEX IF NOT EXISTS eventos_em ON eventos(em);
  CREATE INDEX IF NOT EXISTS eventos_lead ON eventos(lead_id);
`);

const ins = db.prepare(`INSERT INTO eventos(em, nivel, servico, acao, lead_id, contato, telefone, mensagem, detalhe, origem, lote)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Registra um evento. `p` = contato (lead_id, nome, sobrenome, telefone) quando houver. */
export function registrar({ nivel = 'info', servico = 'sistema', acao, p, mensagem = '', detalhe = '', origem = 'sistema', lote = null, em }) {
  try {
    ins.run(em || new Date().toISOString(), nivel, servico, acao, p?.lead_id ?? null,
      p ? `${p.nome || ''} ${p.sobrenome || ''}`.trim() : null, p?.telefone ?? null,
      String(mensagem).slice(0, 1000), String(detalhe || '').slice(0, 2000), origem, lote);
  } catch (e) { console.error('[eventos] falha ao registrar:', e.message); }
}

/** Erro com o serviço e a etapa onde aconteceu — é o que aparece no relatório */
export class FalhaServico extends Error {
  constructor(servico, etapa, motivo, detalhe = '') {
    super(`${etapa}: ${motivo}`);
    this.servico = servico; this.etapa = etapa; this.motivo = motivo; this.detalhe = detalhe;
  }
}

export const NOME_SERVICO = { whatsapp: 'WhatsApp', botconversa: 'Botconversa', crm: 'CRM', mautic: 'Mautic', sistema: 'Sistema', painel: 'Painel' };

/** Consulta com filtros, para o painel e para a planilha */
export function consultar({ desde, ate, servico, nivel, q, limit = 100, offset = 0 } = {}) {
  const w = [], a = [];
  if (desde) { w.push('em >= ?'); a.push(desde); }
  if (ate) { w.push('em < ?'); a.push(ate); }
  if (servico) { w.push('servico = ?'); a.push(servico); }
  if (nivel === 'falhas') w.push(`nivel IN ('erro', 'aviso')`);
  else if (nivel) { w.push('nivel = ?'); a.push(nivel); }
  if (q) { w.push(`(contato LIKE ? OR telefone LIKE ? OR mensagem LIKE ? OR acao LIKE ? OR detalhe LIKE ?)`); a.push(...Array(5).fill(`%${q}%`)); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM eventos ${where}`).get(...a).n;
  const itens = db.prepare(`SELECT * FROM eventos ${where} ORDER BY em DESC, id DESC LIMIT ? OFFSET ?`).all(...a, limit, offset);
  // resumo por serviço no mesmo período (sem os filtros de serviço/nível/busca)
  const wp = [], ap = [];
  if (desde) { wp.push('em >= ?'); ap.push(desde); }
  if (ate) { wp.push('em < ?'); ap.push(ate); }
  const resumo = db.prepare(`SELECT servico, nivel, COUNT(*) n FROM eventos ${wp.length ? 'WHERE ' + wp.join(' AND ') : ''} GROUP BY servico, nivel`).all(...ap);
  return { total, itens, resumo };
}
