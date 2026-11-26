import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(dir, { recursive: true });
export const db = new DatabaseSync(path.join(dir, 'remarketing.db'));
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
