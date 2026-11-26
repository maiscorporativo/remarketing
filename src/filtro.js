/**
 * Quais e-mails [ABRADILAN] entram no remarketing.
 * Regra: e-mails disparados a partir de `desde` entram sozinhos; `incluir`/`excluir` são exceções escolhidas no painel.
 */
import { db, getState, setState } from './db.js';
import { config } from './config.js';

export const getFiltro = () => ({ desde: config.emailsDesde, incluir: [], excluir: [], ...getState('filtroEmails', {}) });

export const entraPelaData = (e, f) => !!e.nome_ok && (!f.desde || (!!e.enviado_em && e.enviado_em.slice(0, 10) >= f.desde));
export const incluido = (e, f) => !!e.nome_ok && (f.incluir.includes(e.id) || (entraPelaData(e, f) && !f.excluir.includes(e.id)));

/** Recalcula emails.alvo e tira da fila quem só clicou em e-mails excluídos (só quem ainda não recebeu nada) */
export function aplicarFiltro() {
  const f = getFiltro();
  const set = db.prepare('UPDATE emails SET alvo = ? WHERE id = ?');
  for (const e of db.prepare('SELECT id, nome_ok, enviado_em FROM emails').all()) set.run(incluido(e, f) ? 1 : 0, e.id);
  db.prepare(`
    DELETE FROM contatos WHERE status IN ('pendente', 'sem_whatsapp', 'inscrito') AND tentativas = 0
      AND lead_id NOT IN (SELECT c.lead_id FROM clicks c JOIN emails e ON e.id = c.email_id WHERE e.alvo = 1)`).run();
}

export function validarFiltro(b) {
  const desde = String(b?.desde ?? '');
  if (desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error('Data inválida');
  const ids = (x) => [...new Set((Array.isArray(x) ? x : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const incluir = ids(b?.incluir), excluir = ids(b?.excluir).filter((id) => !incluir.includes(id));
  return { desde, incluir, excluir };
}

export const salvarFiltro = (f) => setState('filtroEmails', f);
