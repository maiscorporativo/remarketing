/**
 * Painel web de acompanhamento, protegido por usuário e senha.
 *   GET /               → painel
 *   GET /api/status     → dados do painel (JSON)
 *   POST /api/filtro    → escolhe quais e-mails [ABRADILAN] entram no remarketing
 *   GET  /api/proximos  → quem recebe no próximo lote (para confirmar antes de enviar)
 *   POST /api/enviar    → envia um lote agora
 *   POST /api/automatico → liga/pausa os envios automáticos
 *   GET /contatos.csv   → planilha com todos os contatos
 *   GET /api/eventos    → relatório de atividades (filtros: periodo, servico, nivel, q)
 *   GET /eventos.csv    → relatório de atividades em planilha
 *   POST /api/cron      → executa uma verificação (para agendador externo, com CRON_TOKEN)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db, getState, APP_DIR, DATA_DIR, DB_FILE, DB_IMPORTAR, importacaoAplicada } from './db.js';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { getFiltro, entraPelaData, validarFiltro } from './filtro.js';
import { consultar, NOME_SERVICO } from './eventos.js';

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'painel.html');
const MAX_TENTATIVAS = 5;

function status(ctrl) {
  const desde = new Date(Date.now() - config.janelaDias * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const limite = new Date(Date.now() - config.delayMin * 6e4).toISOString().slice(0, 19).replace('T', ' ');
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const totais = {
    clicaram: one('SELECT COUNT(*) n FROM contatos'),
    inscritosAntes: one(`SELECT COUNT(*) n FROM contatos WHERE status = 'inscrito'`),
    semWhatsapp: one(`SELECT COUNT(*) n FROM contatos WHERE status = 'sem_whatsapp'`),
    enviados: one(`SELECT COUNT(*) n FROM contatos WHERE status = 'enviado'`),
    convertidos: one(`SELECT COUNT(*) n FROM contatos WHERE status = 'enviado' AND convertido_em IS NOT NULL`),
    naFila: one(`SELECT COUNT(*) n FROM contatos WHERE status IN ('pendente','erro') AND tentativas < ? AND ultimo_clique >= ? AND ultimo_clique <= ? AND ${NO_FILTRO}`, MAX_TENTATIVAS, desde, limite),
    aguardandoPrazo: one(`SELECT COUNT(*) n FROM contatos WHERE status IN ('pendente','erro') AND tentativas < ? AND ultimo_clique > ? AND ${NO_FILTRO}`, MAX_TENTATIVAS, limite),
    falhasPendentes: one(`SELECT COUNT(*) n FROM contatos WHERE status = 'erro' AND tentativas < ? AND ${NO_FILTRO}`, MAX_TENTATIVAS),
    falhas: one(`SELECT COUNT(*) n FROM contatos WHERE status = 'erro' AND tentativas >= ?`, MAX_TENTATIVAS),
  };
  // envios por dia (horário de Brasília)
  const porDia = db.prepare(`
    SELECT date(enviado_em, '-3 hours') dia, COUNT(*) enviados, SUM(convertido_em IS NOT NULL) convertidos
    FROM contatos WHERE status = 'enviado' AND enviado_em IS NOT NULL GROUP BY dia ORDER BY dia`).all();
  const filtro = getFiltro();
  const emails = db.prepare(`
    SELECT e.id, e.name, e.enviado_em, e.alvo, e.nome_ok,
      COUNT(DISTINCT c.lead_id) clicaram,
      COUNT(DISTINCT CASE WHEN k.status = 'enviado' THEN c.lead_id END) abordados,
      COUNT(DISTINCT CASE WHEN k.convertido_em IS NOT NULL THEN c.lead_id END) convertidos
    FROM emails e LEFT JOIN clicks c ON c.email_id = e.id LEFT JOIN contatos k ON k.lead_id = c.lead_id
    WHERE e.nome_ok = 1 GROUP BY e.id ORDER BY COALESCE(e.enviado_em, '9999') DESC, e.id DESC`).all()
    .map(({ nome_ok, ...e }) => ({ ...e, alvo: !!e.alvo, pelaData: entraPelaData({ ...e, nome_ok }, filtro) }));
  const contatos = db.prepare(`
    SELECT lead_id, nome, sobrenome, empresa, email, telefone, status, tentativas, ultimo_erro, ultimo_clique, email_origem, enviado_em, convertido_em
    FROM contatos ORDER BY COALESCE(enviado_em, ultimo_clique) DESC`).all()
    .map((c) => ({ ...c, situacao: situacao(c, limite) }));
  return {
    geradoEm: new Date().toISOString(),
    envios: ctrl.estado(),
    config: { delayMin: config.delayMin, intervaloMin: config.intervaloMin, maxPorCiclo: config.maxPorCiclo, formIds: config.formIds, fluxo: config.botconversa.flowId },
    ultimoCiclo: getState('ultimoCiclo'),
    totais, porDia, emails, contatos, filtro,
    sistema: {
      banco: DB_FILE,
      // banco dentro da pasta do app = apagado a cada deploy na hospedagem
      bancoDentroDoApp: DB_FILE.startsWith(APP_DIR + path.sep),
      dataDirDefinido: !!process.env.DATA_DIR,
      importacaoPendente: existsSync(DB_IMPORTAR),
      importacaoAplicada,
    },
  };
}
const NO_FILTRO = `lead_id IN (SELECT c.lead_id FROM clicks c JOIN emails e ON e.id = c.email_id WHERE e.alvo = 1)`;

function situacao(c, limite) {
  if (c.status === 'enviado') return c.convertido_em ? 'convertido' : 'enviado';
  if (c.status === 'inscrito') return 'inscrito';
  if (c.status === 'sem_whatsapp') return 'sem_whatsapp';
  if (c.status === 'erro' && c.tentativas >= MAX_TENTATIVAS) return 'falhou';
  return c.ultimo_clique > limite ? 'aguardando' : 'fila';
}

const ROTULO = { convertido: 'Inscreveu-se após WhatsApp', enviado: 'WhatsApp enviado', inscrito: 'Já inscrito (não abordado)', sem_whatsapp: 'Sem celular', falhou: 'Falhou', aguardando: 'Aguardando prazo', fila: 'Na fila' };
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const br = (s) => (s ? new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
function csv(ctrl) {
  const head = ['ID Mautic', 'Nome', 'Empresa', 'E-mail', 'WhatsApp', 'Situação', 'E-mail clicado', 'Último clique', 'WhatsApp enviado em', 'Inscreveu-se em', 'Erro'];
  const rows = status(ctrl).contatos.map((c) => [c.lead_id, `${c.nome} ${c.sobrenome}`.trim(), c.empresa, c.email, c.telefone, ROTULO[c.situacao],
    c.email_origem, br(c.ultimo_clique), br(c.enviado_em), br(c.convertido_em), c.ultimo_erro]);
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
}

/** período do relatório → datas ISO */
function filtrosEventos(url) {
  const g = (k) => url.searchParams.get(k) || '';
  const per = g('periodo') || '7d';
  const dias = { hoje: 0, '7d': 7, '30d': 30 }[per];
  let desde = '';
  if (per === 'hoje') { const d = new Date(Date.now() - 3 * 3600e3); desde = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 3 * 3600e3).toISOString(); }
  else if (dias) desde = new Date(Date.now() - dias * 864e5).toISOString();
  return { desde, servico: g('servico'), nivel: g('nivel'), q: g('q').slice(0, 100) };
}
const NIVEL = { ok: 'Sucesso', info: 'Informação', aviso: 'Atenção', erro: 'Falha' };
function eventosCsv(url) {
  const head = ['Data e hora', 'Resultado', 'Serviço', 'Ação', 'Contato', 'WhatsApp', 'ID Mautic', 'Mensagem', 'Detalhe técnico', 'Origem', 'Lote'];
  const rows = consultar({ ...filtrosEventos(url), limit: 100000 }).itens.map((e) => [br(e.em), NIVEL[e.nivel] || e.nivel, NOME_SERVICO[e.servico] || e.servico, e.acao, e.contato, e.telefone, e.lead_id, e.mensagem, e.detalhe, e.origem, e.lote]);
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const page = (res, code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };
const loginHtml = (erro) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remarketing ABRADILAN</title><style>
:root{--page:#f6f7f9;--surface:#fff;--border:#e3e6eb;--text:#191919;--text-2:#5f6670;--accent:#257de0;--critical:#dc3c3d}
@media (prefers-color-scheme:dark){:root{--page:#0b0b0b;--surface:#191919;--border:#2e2e2e;--text:#efefef;--text-2:#a7a7a7;--accent:#338ced}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--page);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
form{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px}
h1{font-size:19px;margin:0 0 4px}p{color:var(--text-2);margin:0 0 20px;font-size:13px}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}
input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--critical);font-size:13px;margin:12px 0 0}
</style></head><body><form method="post" action="/login">
<h1>Remarketing ABRADILAN</h1><p>Acompanhamento dos envios · Hospedagem 2027</p>
<label for="u">Usuário</label><input id="u" name="usuario" autocomplete="username" required autofocus>
<label for="s">Senha</label><input id="s" name="senha" type="password" autocomplete="current-password" required>
${erro ? `<div class="err">${erro}</div>` : ''}<button>Entrar</button></form></body></html>`;

export function startPainel(ctrl) {
  // na hospedagem a porta vem em PORT; localmente PAINEL_PORTA (padrão 3010)
  const port = Number(process.env.PORT) || Number(process.env.PAINEL_PORTA) || 3010;
  const cronToken = process.env.CRON_TOKEN || '';
  const user = process.env.PAINEL_USUARIO || 'admin';
  const pass = process.env.PAINEL_SENHA || '';
  if (!pass) { console.warn('[painel] defina PAINEL_SENHA no .env para ligar o painel'); return; }
  // sessão por cookie assinado (vale 12h); a assinatura muda se a senha mudar
  const secret = crypto.createHash('sha256').update(`painel:${user}:${pass}`).digest();
  const sign = (exp) => crypto.createHmac('sha256', secret).update(String(exp)).digest('base64url');
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const logado = (req) => {
    const m = /(?:^|;\s*)painel=(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
    return !!m && Number(m[1]) > Date.now() && same(m[2], sign(m[1]));
  };
  const tentativas = new Map(); // ip → [falhas, desde]

  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // atrás do proxy da hospedagem, o IP real vem no X-Forwarded-For
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';

    // agendador externo (ex.: n8n a cada 15 min): mantém as verificações rodando mesmo se a hospedagem adormecer o app
    if (url.pathname === '/api/cron') {
      if (!cronToken || !same(req.headers['x-cron-token'] || url.searchParams.get('token') || '', cronToken)) return json(res, 403, { erro: 'token inválido' });
      try { return json(res, 200, { ok: true, ...(await ctrl.cicloAgora()) }); } catch (e) { return json(res, 500, { ok: false, erro: e.message }); }
    }
    if (url.pathname === '/saude') return json(res, 200, { ok: true, em: new Date().toISOString() });

    if (url.pathname === '/login' && req.method === 'POST') {
      let body = ''; for await (const ch of req) { body += ch; if (body.length > 4096) break; }
      const f = new URLSearchParams(body);
      const [falhas = 0, desde = 0] = tentativas.get(ip) || [];
      if (falhas >= 5 && Date.now() - desde < 15 * 6e4) return page(res, 429, loginHtml('Muitas tentativas. Aguarde 15 minutos.'));
      if (same(f.get('usuario') || '', user) & same(f.get('senha') || '', pass)) {
        tentativas.delete(ip);
        const exp = Date.now() + 12 * 3600e3;
        res.writeHead(303, { location: '/', 'set-cookie': `painel=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}` });
        return res.end();
      }
      tentativas.set(ip, [falhas + 1, falhas ? desde : Date.now()]);
      return page(res, 401, loginHtml('Usuário ou senha incorretos.'));
    }
    if (url.pathname === '/sair') { res.writeHead(303, { location: '/login', 'set-cookie': 'painel=; Path=/; Max-Age=0' }); return res.end(); }
    if (!logado(req)) {
      if (url.pathname.startsWith('/api/')) { res.writeHead(401); return res.end('{"erro":"login"}'); }
      if (url.pathname !== '/login') { res.writeHead(303, { location: '/login' }); return res.end(); }
      return page(res, 200, loginHtml(''));
    }
    try {
      if (url.pathname === '/login') { res.writeHead(303, { location: '/' }); return res.end(); }
      // "Importar banco de dados": recebe o arquivo .db, confere e deixa pronto para aplicar no próximo reinício
      if (req.method === 'POST' && url.pathname === '/api/importar-banco') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { erro: 'origem não permitida' });
        const partes = []; let tam = 0;
        for await (const ch of req) { tam += ch.length; if (tam > 50 * 1024 * 1024) return json(res, 413, { erro: 'arquivo grande demais (máx. 50 MB)' }); partes.push(ch); }
        const buf = Buffer.concat(partes);
        if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') return json(res, 400, { erro: 'o arquivo não é um banco de dados do sistema (remarketing.db)' });
        const tmp = DB_IMPORTAR + '.conferindo';
        writeFileSync(tmp, buf);
        try {
          const t = new DatabaseSync(tmp, { readOnly: true });
          const tabelas = new Set(t.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
          for (const nome of ['contatos', 'emails', 'clicks', 'state']) if (!tabelas.has(nome)) throw new Error(`o arquivo não tem a tabela "${nome}" — não é um banco deste sistema`);
          const n = (sql) => t.prepare(sql).get().n;
          const resumo = {
            contatos: n('SELECT COUNT(*) n FROM contatos'),
            enviados: n("SELECT COUNT(*) n FROM contatos WHERE status = 'enviado'"),
            falhas: n("SELECT COUNT(*) n FROM contatos WHERE status = 'erro'"),
            eventos: tabelas.has('eventos') ? n('SELECT COUNT(*) n FROM eventos') : 0,
          };
          t.close();
          renameSync(tmp, DB_IMPORTAR);
          return json(res, 200, { ok: true, resumo });
        } catch (e) { rmSync(tmp, { force: true }); return json(res, 400, { erro: e.message }); }
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // ações só a partir do próprio painel (bloqueia pedidos vindos de outros sites)
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { erro: 'origem não permitida' });
        let body = ''; for await (const ch of req) { body += ch; if (body.length > 20000) break; }
        let b; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { erro: 'JSON inválido' }); }
        try {
          if (url.pathname === '/api/filtro') { await ctrl.mudarFiltro(validarFiltro(b)); return json(res, 200, status(ctrl)); }
          if (url.pathname === '/api/automatico') { ctrl.setAutomatico(!!b.ativo); return json(res, 200, status(ctrl)); }
          if (url.pathname === '/api/enviar') { ctrl.enviarAgora(b.quantidade, !!b.soFalhas); return json(res, 200, status(ctrl)); }
        } catch (e) { return json(res, 400, { erro: e.message }); }
        return json(res, 404, { erro: 'não encontrado' });
      }
      if (url.pathname === '/api/proximos') {
        const n = Math.max(1, Math.min(Number(url.searchParams.get('n')) || 5, 200));
        return json(res, 200, ctrl.proximos(n, url.searchParams.get('falhas') === '1').map((p) => ({ lead_id: p.lead_id, falta: p.status === 'erro' ? (p.botconversa_ok ? 'só CRM' : p.crm_ok ? 'só WhatsApp' : 'WhatsApp e CRM') : '', erro: p.ultimo_erro, nome: `${p.nome} ${p.sobrenome}`.trim(), empresa: p.empresa, telefone: p.telefone, ultimo_clique: p.ultimo_clique, email_origem: p.email_origem })));
      }
      if (url.pathname === '/api/eventos') return json(res, 200, consultar({ ...filtrosEventos(url), limit: Math.min(Number(url.searchParams.get('limit')) || 100, 500), offset: Number(url.searchParams.get('offset')) || 0 }));
      if (url.pathname === '/eventos.csv') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="relatorio-remarketing-${new Date().toISOString().slice(0, 10)}.csv"` });
        return res.end(eventosCsv(url));
      }
      if (url.pathname === '/api/status') return json(res, 200, status(ctrl));
      if (url.pathname === '/contatos.csv') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="remarketing-abradilan-${new Date().toISOString().slice(0, 10)}.csv"` });
        return res.end(csv(ctrl));
      }
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(readFileSync(HTML)); }
      res.writeHead(404); res.end('Não encontrado');
    } catch (e) { res.writeHead(500); res.end(e.message); }
  }).listen(port, () => console.log(`[painel] http://localhost:${port}  (usuário: ${user})`));
}
