# Publicar na Hostinger (app web Node.js)

Endereço: **https://remarketing.mais.tur.br**. O app roda o painel e as verificações automáticas no mesmo processo.

## 1. Criar o app

hPanel → **Sites → Adicionar site → Deploy Web App (Node.js) → GitHub** → repositório `maiscorporativo/remarketing`, branch `main`.

| Configuração | Valor |
|---|---|
| Versão do Node | **22.x (22.13 ou mais nova) ou 24.x**. O app usa o SQLite embutido do Node. |
| Comando de build | `npm install` (o projeto não tem dependências) |
| Arquivo de entrada / start | `server.js` (ou `npm start`) |

## 2. Variáveis de ambiente

Cadastre todas no painel do app. Os valores estão no arquivo local `deploy/hostinger.env`, gerado no computador onde o sistema rodava e que nunca vai para o GitHub. Ele pode ser importado direto no painel da Hostinger. As obrigatórias são:

`MAUTIC_URL`, `MAUTIC_USER`, `MAUTIC_PASS`, `BOTCONVERSA_API_KEY`, `BOTCONVERSA_FLOW_ID`, `CRM_WEBHOOK_URL`,
`PAINEL_USUARIO`, `PAINEL_SENHA`, `DATA_DIR`, `CRON_TOKEN`, `EMAILS_DESDE` e as regras (`DELAY_MINUTOS` etc.).

Cuidados:
- **Não cadastre `PORT`.** A Hostinger define a porta sozinha.
- **`DATA_DIR`** precisa apontar para uma pasta **fora** da pasta do app, por exemplo `/home/u770723521/dados-remarketing`. Cada deploy substitui a pasta do app; se o banco ficar dentro dela, os dados se perdem.

## 3. Levar os dados atuais (envios já feitos e relatório)

1. No computador onde o sistema rodava, **pare o sistema** (Ctrl+C no terminal do `npm start`).
2. Rode `npm run exportar-banco`. Ele gera `deploy/remarketing.db`.
3. hPanel → **Gerenciador de arquivos**: crie a pasta do `DATA_DIR` (ex.: `dados-remarketing`) e envie o `remarketing.db` para dentro dela.
4. Reinicie o app no hPanel.

> **Depois disso, não use mais o sistema local.** Ele tem um banco separado: se os dois rodarem, a mesma pessoa pode receber duas vezes.

## 4. Domínio

No app, em **Domínios**, conecte `remarketing.mais.tur.br`. O DNS de mais.tur.br está na própria Hostinger. Se ela não criar o registro sozinha, crie o registro que o painel indicar.

Para testar:
- `https://remarketing.mais.tur.br/saude` deve responder `{"ok":true,...}`;
- o login do painel deve mostrar os mesmos números do sistema local.

## 5. Agendador no n8n (recomendado)

A hospedagem pode adormecer o app quando ninguém o acessa. Para as verificações a cada 15 minutos nunca pararem, crie no n8n:

- **Schedule Trigger**: a cada 15 minutos;
- **HTTP Request**: `POST https://remarketing.mais.tur.br/api/cron`, com o cabeçalho `X-Cron-Token: <valor do CRON_TOKEN>`.

O app ignora a chamada se uma verificação acabou de rodar, então não há verificação duplicada.

## 6. Conferir a persistência

Antes de confiar no ambiente, faça um redeploy, pelo botão do hPanel ou com um commit novo. Depois confira se os envios e o relatório continuam no painel.

## Atualizações

Todo `git push` na branch `main` publica de novo. Os dados ficam no `DATA_DIR` e não são afetados.
