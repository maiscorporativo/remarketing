/**
 * Gera uma cópia única e consistente do banco (contatos, envios, filtro e relatório)
 * para subir na hospedagem: deploy/remarketing.db
 *   npm run exportar-banco
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const origem = path.join(process.env.DATA_DIR || path.join(raiz, 'data'), 'remarketing.db');
const destinoDir = path.join(raiz, 'deploy');
const destino = path.join(destinoDir, 'remarketing.db');
if (!existsSync(origem)) { console.error('Banco não encontrado em', origem); process.exit(1); }
mkdirSync(destinoDir, { recursive: true });
rmSync(destino, { force: true });

const db = new DatabaseSync(origem);
db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
const conta = (sql) => db.prepare(sql).get().n;
console.log('Banco exportado para:', destino, `(${Math.round(statSync(destino).size / 1024)} KB)`);
console.log(' contatos:', conta('SELECT COUNT(*) n FROM contatos'),
  '| WhatsApp enviados:', conta(`SELECT COUNT(*) n FROM contatos WHERE status = 'enviado'`),
  '| falhas a reenviar:', conta(`SELECT COUNT(*) n FROM contatos WHERE status = 'erro'`),
  '| eventos no relatório:', conta('SELECT COUNT(*) n FROM eventos'));
console.log('\nIMPORTANTE: depois de subir este arquivo, NÃO use mais o sistema local — senão os dois bancos se desencontram e alguém pode receber duas vezes.');
