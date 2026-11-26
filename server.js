/**
 * Entrada do app (Hostinger: "node server.js").
 * Carrega o .env quando existir (uso local). Na hospedagem as variáveis vêm do painel.
 * Sem top-level await: a Hostinger carrega este arquivo com require().
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

import('./src/index.js').catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
