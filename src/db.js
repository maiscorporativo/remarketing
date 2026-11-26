import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, 'data'));
export const DB_FILE = path.join(DATA_DIR, 'remarketing.db');
export const DB_IMPORTAR = DB_FILE + '.importar';
mkdirSync(DATA_DIR, { recursive: true });

// banco enviado pelo painel ("Importar banco de dados") é aplicado aqui, na subida, antes de abrir o banco
export let importacaoAplicada = null;
if (existsSync(DB_IMPORTAR)) {
  const backup = existsSync(DB_FILE) ? `${DB_FILE}.antes-da-importacao-${new Date().toISOString().replace(/[:.]/g, '-')}` : null;
  if (backup) renameSync(DB_FILE, backup);
  for (const s of ['-wal', '-shm']) rmSync(DB_FILE + s, { force: true });
  renameSync(DB_IMPORTAR, DB_FILE);
  importacaoAplicada = { em: new Date().toISOString(), backup };
  console.log('[db] banco importado aplicado', backup ? `(anterior guardado em ${backup})` : '');
}

export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
  -- cache dos nomes dos e-mails do Mautic (para saber quais são [ABRADILAN])
  CREATE TABLE IF NOT EXISTS emails (id INTEGER PRIMARY KEY, name TEXT, alvo INTEGER);
  -- cliques no site vindos dos e-mails-alvo
  CREATE TABLE IF NOT EXISTS clicks (
    hit_id INTEGER PRIMARY KEY, lead_id INTEGER, email_id INTEGER, url TEXT, date_hit TEXT
  );
  CREATE INDEX IF NOT EXISTS clicks_lead ON clicks(lead_id);
  -- um registro por contato: nunca dispara duas vezes para a mesma pessoa
  CREATE TABLE IF NOT EXISTS contatos (
    lead_id INTEGER PRIMARY KEY,
    nome TEXT, sobrenome TEXT, email TEXT, empresa TEXT, telefone TEXT,
    primeiro_clique TEXT, ultimo_clique TEXT, email_origem TEXT,
    status TEXT,              -- pendente | enviado | inscrito | sem_whatsapp | erro
    botconversa_ok INTEGER DEFAULT 0, crm_ok INTEGER DEFAULT 0, tentativas INTEGER DEFAULT 0,
    ultimo_erro TEXT, enviado_em TEXT, atualizado_em TEXT
  );
`);

// migrações simples
for (const sql of [
  'ALTER TABLE contatos ADD COLUMN convertido_em TEXT',
  // nome_ok = nome casa com [ABRADILAN]; enviado_em = primeiro disparo do e-mail; alvo = incluído no remarketing
  'ALTER TABLE emails ADD COLUMN nome_ok INTEGER',
  'ALTER TABLE emails ADD COLUMN enviado_em TEXT',
]) { try { db.exec(sql); } catch { /* já existe */ } }
db.exec('UPDATE emails SET nome_ok = alvo WHERE nome_ok IS NULL');

export const getState = (k, d = null) => {
  const r = db.prepare('SELECT value FROM state WHERE key = ?').get(k);
  return r ? JSON.parse(r.value) : d;
};
export const setState = (k, v) => db.prepare('INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
