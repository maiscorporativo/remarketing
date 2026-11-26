/**
 * Remarketing ABRADILAN
 *  1. Lê no Mautic os cliques em links dos e-mails cujo nome começa com [ABRADILAN] (só links do site).
 *  2. Descarta quem já se inscreveu no formulário 31 (por e-mail ou telefone).
 *  3. Espera DELAY_MINUTOS após o clique; então dispara o fluxo do Botconversa e cria o negócio no CRM.
 *  4. Cada contato é abordado uma única vez (controle em data/remarketing.db).
 *
 *  npm run previa      → mostra quem receberia, sem disparar
 *  npm run once        → um ciclo
 *  npm start           → modo contínuo (a cada INTERVALO_MINUTOS)
 *  npm run relatorio   → situação de todos os contatos
 */
import { config, checkConfig } from './config.js';
import { db, getState, setState } from './db.js';
import * as mautic from './mautic.js';
import { sendBotconversa, sendCrm, listBotconversa, payload } from './senders.js';
import { toWhatsapp, phoneKey } from './phone.js';
import { startPainel } from './painel.js';
import { aplicarFiltro, salvarFiltro } from './filtro.js';
import { registrar, NOME_SERVICO } from './eventos.js';

const args = new Set(process.argv.slice(2));
// --dry-run (npm run previa) = nunca envia, nem pelo painel
const PREVIA_FORCADA = args.has('--dry-run');
const MAX_TENTATIVAS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (...a) => console.log(`[${new Date().toLocaleString('pt-BR')}]`, ...a);
const utc = (s) => new Date(String(s).replace(' ', 'T') + 'Z'); // Mautic grava em UTC
const sqlDate = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// ---------------------------------------------------------------- 1. cliques
async function syncClicks() {
  const desde = sqlDate(new Date(Date.now() - config.janelaDias * 864e5));
  // janela ampliada no .env → relê os cliques antigos (duplicados são ignorados)
  if (config.janelaDias > getState('janelaDias', 0)) { setState('lastHitId', 0); setState('janelaDias', config.janelaDias); }
  const lastHit = getState('lastHitId', 0);
  const hits = await mautic.fetchEmailClicks(lastHit, desde);

  const conhecidos = new Set(db.prepare('SELECT id FROM emails').all().map((r) => r.id));
  const novos = [...new Set(hits.map((h) => Number(h.email_id)))].filter((id) => !conhecidos.has(id));
  const insEmail = db.prepare('INSERT OR REPLACE INTO emails(id, name, alvo, nome_ok, enviado_em) VALUES(?, ?, 0, ?, NULL)');
  for (const id of novos) {
    const name = await mautic.getEmailName(id);
    insEmail.run(id, name, config.emailNamePattern.test(name) ? 1 : 0);
  }
  // data do primeiro disparo de cada e-mail [ABRADILAN] (usada no filtro "a partir de")
  const setData = db.prepare('UPDATE emails SET enviado_em = ? WHERE id = ?');
  for (const e of db.prepare('SELECT id FROM emails WHERE nome_ok = 1 AND enviado_em IS NULL').all()) {
    const d = await mautic.getEmailFirstSend(e.id);
    if (d) setData.run(d, e.id);
  }
  aplicarFiltro();

  // guarda os cliques de TODOS os e-mails [ABRADILAN]; o filtro decide quais contam
  const monitorados = new Set(db.prepare('SELECT id FROM emails WHERE nome_ok = 1').all().map((r) => r.id));
  const ins = db.prepare('INSERT OR IGNORE INTO clicks(hit_id, lead_id, email_id, url, date_hit) VALUES(?, ?, ?, ?, ?)');
  let n = 0;
  for (const h of hits) {
    if (!h.lead_id || !monitorados.has(Number(h.email_id)) || !String(h.url || '').includes(config.siteUrlPattern)) continue;
    n += Number(ins.run(Number(h.id), Number(h.lead_id), Number(h.email_id), h.url, h.date_hit).changes);
  }
  if (hits.length) setState('lastHitId', Math.max(lastHit, ...hits.map((h) => Number(h.id))));
  const emailsAlvo = db.prepare('SELECT COUNT(*) n FROM emails WHERE alvo = 1').get().n;
  return { hitsLidos: hits.length, cliquesNovos: n, emailsAlvo };
}

// ---------------------------------------------------------------- 2. inscritos no formulário
async function loadInscritos() {
  const emails = new Set(), phones = new Set(), leads = new Set();
  for (const formId of config.formIds) {
    for (const s of await mautic.getFormSubmissions(formId)) {
      const r = s.results || {};
      if (s.lead?.id) leads.add(Number(s.lead.id));
      for (const [k, v] of Object.entries(r)) {
        if (/e_?mail/.test(k) && v) emails.add(String(v).trim().toLowerCase());
        if (/whats|celular|telefone|phone|fone/.test(k) && v) { const key = phoneKey(v); if (key) phones.add(key); }
      }
    }
  }
  return { emails, phones, leads };
}

// ---------------------------------------------------------------- 3. classificar contatos
async function refreshContatos(inscritos) {
  const candidatos = db.prepare(`
    SELECT c.lead_id, MIN(c.date_hit) primeiro, MAX(c.date_hit) ultimo,
           (SELECT e2.name FROM clicks c2 JOIN emails e2 ON e2.id = c2.email_id WHERE c2.lead_id = c.lead_id AND e2.alvo = 1 ORDER BY c2.date_hit DESC LIMIT 1) email_origem
    FROM clicks c JOIN emails e ON e.id = c.email_id AND e.alvo = 1
    LEFT JOIN contatos k ON k.lead_id = c.lead_id
    WHERE k.lead_id IS NULL OR k.status IN ('pendente', 'erro')
    GROUP BY c.lead_id`).all();
  if (!candidatos.length) return;

  const fichas = await mautic.getContacts(candidatos.map((c) => c.lead_id));
  const up = db.prepare(`
    INSERT INTO contatos(lead_id, nome, sobrenome, email, empresa, telefone, primeiro_clique, ultimo_clique, email_origem, status, atualizado_em)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET nome = excluded.nome, sobrenome = excluded.sobrenome, email = excluded.email, empresa = excluded.empresa,
      telefone = excluded.telefone, ultimo_clique = excluded.ultimo_clique, email_origem = excluded.email_origem,
      status = CASE WHEN excluded.status = 'pendente' AND contatos.status = 'erro' THEN 'erro' ELSE excluded.status END,
      atualizado_em = excluded.atualizado_em`);

  for (const c of candidatos) {
    const f = fichas.get(c.lead_id) || {};
    const email = String(f.email || '').trim().toLowerCase();
    const tel = toWhatsapp(f.mobile) || toWhatsapp(f.whatsapp) || toWhatsapp(f.phone);
    const inscrito = inscritos.leads.has(c.lead_id) || (email && inscritos.emails.has(email))
      || [f.mobile, f.phone, f.whatsapp].some((p) => p && inscritos.phones.has(phoneKey(p)));
    const status = inscrito ? 'inscrito' : !tel ? 'sem_whatsapp' : 'pendente';
    up.run(c.lead_id, f.firstname || '', f.lastname || '', email, f.company || '', tel || String(f.mobile || f.phone || ''),
      c.primeiro, c.ultimo, c.email_origem || '', status, now());
  }
}

// ---------------------------------------------------------------- 4. disparos
const NO_FILTRO = `lead_id IN (SELECT c.lead_id FROM clicks c JOIN emails e ON e.id = c.email_id WHERE e.alvo = 1)`;

/** Próximos contatos prontos para receber (já passaram o prazo após o clique), na ordem de envio */
function proximos(max, soFalhas = false) {
  const limite = sqlDate(new Date(Date.now() - config.delayMin * 6e4));
  const desde = sqlDate(new Date(Date.now() - config.janelaDias * 864e5));
  return db.prepare(`
    SELECT * FROM contatos WHERE status IN (${soFalhas ? "'erro'" : "'pendente', 'erro'"}) AND tentativas < ? AND ultimo_clique <= ? AND ultimo_clique >= ? AND ${NO_FILTRO}
    ORDER BY ultimo_clique DESC LIMIT ?`).all(MAX_TENTATIVAS, limite, desde, max);
}

/** Envia para até `max` contatos da fila. Com real=false só informa o que faria. */
async function disparar({ max = config.maxPorCiclo, real = false, soFalhas = false, progresso, origem = 'automático', lote = null } = {}) {
  const limite = sqlDate(new Date(Date.now() - config.delayMin * 6e4));
  const prontos = proximos(max, soFalhas);
  const aguardando = db.prepare(`SELECT COUNT(*) n FROM contatos WHERE status = 'pendente' AND ultimo_clique > ? AND ${NO_FILTRO}`).get(limite).n;

  if (!real) {
    log(`${PREVIA_FORCADA ? 'PRÉVIA' : 'ENVIOS AUTOMÁTICOS PAUSADOS'} (nada foi enviado): ${prontos.length} pronto(s) para disparo, ${aguardando} aguardando o prazo de ${config.delayMin} min após o clique.`);
    if (PREVIA_FORCADA) console.table(prontos.map((p) => ({ id: p.lead_id, nome: `${p.nome} ${p.sobrenome}`.trim(), empresa: p.empresa, whatsapp: p.telefone, clique: p.ultimo_clique, email: p.email_origem.slice(0, 40) })));
    return { enviados: 0, prontos: prontos.length, aguardando };
  }

  const mark = db.prepare(`UPDATE contatos SET botconversa_ok = ?, crm_ok = ?, tentativas = tentativas + 1, status = ?, ultimo_erro = ?, enviado_em = ?, atualizado_em = ? WHERE lead_id = ?`);
  const jaEnviadoTel = db.prepare(`SELECT lead_id FROM contatos WHERE telefone = ? AND status = 'enviado' AND lead_id <> ?`);
  let enviados = 0;
  const ev = (nivel, servico, acao, p, mensagem, detalhe) => registrar({ nivel, servico, acao, p, mensagem, detalhe, origem, lote });
  for (const p of prontos) {
    const dup = jaEnviadoTel.get(p.telefone, p.lead_id);
    if (dup) {
      mark.run(1, 1, 'enviado', `mesmo WhatsApp do contato ${dup.lead_id}`, now(), now(), p.lead_id);
      ev('info', 'sistema', 'Envio ignorado', p, `Este WhatsApp já recebeu pelo contato ${dup.lead_id} — não enviado de novo`);
      progresso?.(true); continue;
    }
    const tentativa = p.tentativas + 1;
    let bcOk = p.botconversa_ok, crmOk = p.crm_ok; const erros = [];
    const falhou = (e) => {
      const servico = e.servico || 'sistema';
      erros.push(`${NOME_SERVICO[servico] || servico} — ${e.message}`);
      ev('erro', servico, e.etapa || 'Envio', p, `${e.motivo || e.message}${tentativa > 1 ? ` (tentativa ${tentativa})` : ''}`, e.detalhe);
    };
    if (!bcOk) {
      try { const r = await sendBotconversa(p); bcOk = 1; ev('ok', 'botconversa', 'WhatsApp disparado', p, r.resumo); }
      catch (e) { falhou(e); }
    }
    if (!crmOk) {
      try { const r = await sendCrm(p); crmOk = 1; ev('ok', 'crm', 'Negócio no funil do CRM', p, r.resumo); }
      catch (e) { falhou(e); }
    }
    const ok = bcOk && crmOk;
    if (ok) {
      enviados++;
      await mautic.addTag(p.lead_id, config.mautic.tag).catch((e) => ev('aviso', 'mautic', 'Etiquetar contato no Mautic', p, `etiqueta "${config.mautic.tag}" não aplicada: ${e.message}`));
    }
    mark.run(bcOk, crmOk, ok ? 'enviado' : 'erro', erros.join(' | ') || null, ok ? now() : p.enviado_em, now(), p.lead_id);
    if (!ok && tentativa >= MAX_TENTATIVAS) ev('erro', 'sistema', 'Desistência', p, `${MAX_TENTATIVAS} tentativas sem sucesso — o contato não será mais tentado automaticamente`);
    log(ok ? '✔' : '✖', p.lead_id, p.nome, p.telefone, erros.join(' | '));
    progresso?.(ok, erros.join(' | '));
    await sleep(config.pausaSeg * 1000);
  }
  return { enviados, prontos: prontos.length, aguardando };
}

/** Quem recebeu o WhatsApp e depois se inscreveu no formulário = conversão do remarketing */
function marcarConversoes(inscritos) {
  const set = db.prepare('UPDATE contatos SET convertido_em = ? WHERE lead_id = ?');
  for (const c of db.prepare(`SELECT lead_id, email, telefone FROM contatos WHERE status = 'enviado' AND convertido_em IS NULL`).all()) {
    if (inscritos.leads.has(c.lead_id) || (c.email && inscritos.emails.has(c.email)) || (c.telefone && inscritos.phones.has(phoneKey(c.telefone)))) {
      set.run(now(), c.lead_id);
      log('🎉 conversão:', c.lead_id);
      const k = db.prepare('SELECT * FROM contatos WHERE lead_id = ?').get(c.lead_id);
      registrar({ nivel: 'ok', servico: 'mautic', acao: 'Inscrição após o WhatsApp', p: k, mensagem: 'Preencheu o formulário de inscrição depois de receber o WhatsApp (conversão)' });
    }
  }
}

// ---------------------------------------------------------------- ciclo
// ciclo e mudanças vindas do painel rodam um de cada vez
let fila = Promise.resolve();
const serial = (fn) => (fila = fila.then(fn, fn));

/** Chamado pelo painel quando o usuário muda quais e-mails entram */
const mudarFiltro = (f) => serial(async () => {
  salvarFiltro(f);
  aplicarFiltro();
  await refreshContatos(await loadInscritos());
  const msg = `E-mails a partir de ${f.desde ? f.desde.split('-').reverse().join('/') : '(todos)'}; incluídos à mão: ${f.incluir.join(', ') || 'nenhum'}; excluídos à mão: ${f.excluir.join(', ') || 'nenhum'}`;
  log('filtro de e-mails alterado:', msg);
  registrar({ servico: 'painel', acao: 'Filtro de e-mails alterado', mensagem: msg, origem: 'painel' });
});

// ---------------------------------------------------------------- envios comandados pelo painel
/** Envios automáticos (a cada ciclo). Valor inicial vem de DRY_RUN no .env; depois manda o painel. */
const automatico = () => !PREVIA_FORCADA && getState('enviosAutomaticos', !config.dryRun);
const podeEnviar = () => !PREVIA_FORCADA && checkConfig({ needSenders: true }).length === 0;
let envio = null; // lote manual em andamento: { total, feitos, ok, falhas, inicio, fim, erros }

let ultimoCicloEm = 0;
const cicloRegistrado = () => serial(async () => { await ciclo(); ultimoCicloEm = Date.now(); });

const controles = {
  mudarFiltro,
  /** Agendador externo (/api/cron): roda uma verificação, a menos que uma tenha acabado de rodar */
  async cicloAgora() {
    if (Date.now() - ultimoCicloEm < 10 * 6e4) return { executado: false, motivo: 'verificação recente', ultimoCiclo: getState('ultimoCiclo') };
    await cicloRegistrado();
    return { executado: true, ultimoCiclo: getState('ultimoCiclo') };
  },
  proximos: (n, soFalhas) => proximos(n, soFalhas),
  // cicloRodando=false quando só o painel está aberto (npm run painel): o modo automático só age com npm start
  estado: () => ({ automatico: automatico(), podeEnviar: podeEnviar(), previaForcada: PREVIA_FORCADA, cicloRodando: !args.has('--painel'), envio }),
  setAutomatico(on) {
    if (on && !podeEnviar()) throw new Error('Envio indisponível: confira as configurações do Botconversa e do CRM no .env');
    setState('enviosAutomaticos', !!on);
    log(on ? '▶ envios automáticos ATIVADOS pelo painel' : '⏸ envios automáticos PAUSADOS pelo painel');
    registrar({ nivel: on ? 'aviso' : 'info', servico: 'painel', acao: on ? 'Envios automáticos ativados' : 'Envios automáticos pausados',
      mensagem: on ? `A cada ${config.intervaloMin} min, até ${config.maxPorCiclo} contatos da fila` : 'Ninguém recebe mensagem sozinho', origem: 'painel' });
  },
  /** Lote manual: atualiza inscrições antes (quem acabou de se inscrever não recebe) e envia em segundo plano */
  enviarAgora(n, soFalhas = false) {
    if (!podeEnviar()) throw new Error('Envio indisponível: confira as configurações do Botconversa e do CRM no .env');
    if (envio && !envio.fim) throw new Error('Já existe um lote sendo enviado');
    const max = Math.max(1, Math.min(Number(n) || 0, 200));
    envio = { total: max, feitos: 0, ok: 0, falhas: 0, inicio: now(), fim: null, erros: [] };
    const atual = envio;
    const lote = `L${Date.now().toString(36)}`;
    const tipo = soFalhas ? 'Reenvio das falhas' : 'Lote manual';
    log(`▶ ${tipo.toLowerCase()} de até ${max} contato(s) iniciado pelo painel`);
    registrar({ servico: 'painel', acao: `${tipo} iniciado`, mensagem: `Até ${max} contato(s)`, origem: 'manual', lote });
    serial(async () => {
      const inscritos = await etapaCiclo('mautic', 'Ler inscrições do formulário', loadInscritos, 'manual');
      marcarConversoes(inscritos);
      await etapaCiclo('mautic', 'Atualizar contatos', () => refreshContatos(inscritos), 'manual');
      atual.total = proximos(max, soFalhas).length;
      await disparar({ max, real: true, soFalhas, origem: 'manual', lote, progresso: (ok, erro) => { atual.feitos++; ok ? atual.ok++ : (atual.falhas++, atual.erros.push(erro)); } });
    }).catch((e) => { atual.erros.push(e.message); log('erro no lote manual:', e.message); })
      .finally(() => {
        atual.fim = now();
        log(`■ lote manual concluído: ${atual.ok} enviado(s), ${atual.falhas} falha(s)`);
        registrar({ nivel: atual.falhas || atual.erros.length ? 'aviso' : 'ok', servico: 'painel', acao: `${tipo} concluído`,
          mensagem: `${atual.ok} enviado(s), ${atual.falhas} falha(s)${atual.total === 0 ? ' — ninguém pronto na fila' : ''}`, origem: 'manual', lote });
      });
    return envio;
  },
};

/** Executa uma etapa do ciclo; se falhar, registra em qual serviço/etapa foi e repassa o erro */
async function etapaCiclo(servico, acao, fn, origem = 'automático') {
  try { return await fn(); }
  catch (e) {
    registrar({ nivel: 'erro', servico, acao, mensagem: e.message, origem });
    e.registrado = true;
    throw e;
  }
}

async function ciclo() {
  const c = await etapaCiclo('mautic', 'Ler cliques dos e-mails', syncClicks);
  const inscritos = await etapaCiclo('mautic', 'Ler inscrições do formulário', loadInscritos);
  marcarConversoes(inscritos);
  await etapaCiclo('mautic', 'Atualizar contatos', () => refreshContatos(inscritos));
  const real = automatico();
  const d = await disparar({ real, origem: 'automático', lote: real ? `A${Date.now().toString(36)}` : null });
  setState('ultimoCiclo', { em: now(), ...c, ...d });
  log(`ciclo: ${c.hitsLidos} clique(s) lido(s), ${c.cliquesNovos} novo(s) no site via ${c.emailsAlvo} e-mail(s) [ABRADILAN] | ${d.enviados} disparo(s), ${d.aguardando} aguardando prazo`);
  // só registra ciclos em que algo aconteceu (evita poluir o relatório a cada 15 min)
  if (c.cliquesNovos || d.enviados) registrar({ nivel: 'info', servico: 'sistema', acao: 'Verificação automática',
    mensagem: `${c.cliquesNovos} clique(s) novo(s) no site · ${d.enviados} WhatsApp enviado(s)${real ? '' : ' (envios automáticos pausados)'}` , origem: 'automático' });
}

function relatorio() {
  console.log('\nResumo por situação:');
  console.table(db.prepare('SELECT status, COUNT(*) total FROM contatos GROUP BY status ORDER BY total DESC').all());
  console.log('E-mails monitorados:');
  console.table(db.prepare('SELECT e.id, e.name, COUNT(DISTINCT c.lead_id) contatos_clicaram FROM emails e LEFT JOIN clicks c ON c.email_id = e.id WHERE e.alvo = 1 GROUP BY e.id ORDER BY e.id').all());
  console.table(db.prepare(`SELECT lead_id id, nome || ' ' || sobrenome nome, empresa, telefone, status, ultimo_clique, enviado_em, ultimo_erro FROM contatos ORDER BY status, ultimo_clique DESC`).all());
  console.log('Último ciclo:', getState('ultimoCiclo'));
}

async function main() {
  if (args.has('--report')) return relatorio();
  if (args.has('--painel')) return startPainel(controles);
  if (args.has('--botconversa-check')) { const r = await listBotconversa(); console.log(JSON.stringify(r, null, 2)); return; }
  if (args.has('--payload-exemplo')) { console.log(JSON.stringify(payload({ lead_id: 1, nome: 'Maria', sobrenome: 'Silva', email: 'maria@exemplo.com', telefone: '5511999999999', empresa: 'Empresa X', email_origem: '[ABRADILAN] ...', ultimo_clique: '2026-11-25 10:00:00' }), null, 2)); return; }

  // teste com UM número: node --env-file=.env src/index.js --teste 5514999999999 [--so-whatsapp|--so-crm]
  const iTeste = process.argv.indexOf('--teste');
  if (iTeste > 0) {
    const tel = toWhatsapp(process.argv[iTeste + 1]);
    if (!tel) throw new Error('Informe um celular válido depois de --teste');
    const opt = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
    const [nome, ...resto] = (opt('--nome') || 'Teste Remarketing').trim().split(/\s+/);
    const p = { lead_id: 0, nome, sobrenome: resto.join(' '), email: opt('--email'), empresa: 'TESTE - pode excluir', telefone: tel,
      email_origem: '[ABRADILAN] TESTE', ultimo_clique: sqlDate(new Date()) };
    const reg = (nivel, servico, acao, mensagem, detalhe) => registrar({ nivel, servico, acao, p, mensagem, detalhe, origem: 'teste' });
    if (!args.has('--so-crm')) {
      try { const r = await sendBotconversa(p); log('Botconversa:', r.resumo); reg('ok', 'botconversa', 'WhatsApp de teste', r.resumo); }
      catch (e) { log('Botconversa ✖', e.message); reg('erro', e.servico || 'botconversa', e.etapa || 'WhatsApp de teste', e.motivo || e.message, e.detalhe); }
    }
    if (!args.has('--so-whatsapp')) {
      try { const r = await sendCrm(p); log('CRM:', r.resumo); reg('ok', 'crm', 'Negócio de teste no CRM', r.resumo); }
      catch (e) { log('CRM ✖', e.message); reg('erro', e.servico || 'crm', e.etapa || 'Negócio de teste', e.motivo || e.message, e.detalhe); }
    }
    return;
  }

  const errs = checkConfig({ needSenders: false });
  if (errs.length) { errs.forEach((e) => console.error('✖', e)); process.exit(1); }
  log(`Remarketing ABRADILAN — ${PREVIA_FORCADA ? 'MODO PRÉVIA (não dispara)' : automatico() ? 'ENVIOS AUTOMÁTICOS ATIVOS' : 'envios automáticos pausados (ative no painel)'} | Botconversa via ${config.botconversa.webhookUrl ? 'webhook' : 'API'}`);

  if (args.has('--once')) return ciclo();
  startPainel(controles);
  for (;;) {
    // pula se o agendador externo acabou de rodar uma verificação
    if (Date.now() - ultimoCicloEm > 5 * 6e4) { try { await cicloRegistrado(); } catch (e) { log('erro no ciclo:', e.message); } }
    await sleep(config.intervaloMin * 6e4);
  }
}

main().catch((e) => { console.error('✖', e.message); process.exit(1); });
