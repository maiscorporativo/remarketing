# Remarketing ABRADILAN (Mautic → WhatsApp + CRM)

Quem **clicou no site** (`abradilan.mais.tur.br`) a partir de qualquer e-mail do Mautic cujo nome começa com
`[ABRADILAN]` e **não enviou o formulário 31** recebe uma mensagem no WhatsApp (Botconversa) e entra no
funil do CRM (`crm.maiscorporativo.tur.br`) por webhook.

- E-mails novos `[ABRADILAN]` entram sozinhos: o sistema descobre o e-mail no primeiro clique.
- Cliques nos links do rodapé (LinkedIn, Instagram, YouTube, Facebook) são ignorados.
- Espera `DELAY_MINUTOS` (padrão: 120) após o clique antes de abordar. Assim a pessoa tem tempo de se inscrever sozinha.
- Antes de cada disparo, o formulário 31 é relido. Quem se inscreveu (por e-mail ou telefone) é descartado.
- Cada contato recebe **uma única vez**. O controle fica em `data/remarketing.db`.
- Só celulares válidos recebem a mensagem. Telefone fixo fica com a situação `sem_whatsapp`.
- Depois do disparo, o contato ganha a etiqueta `abradilan-remarketing-whatsapp` no Mautic.

## Comandos (Node 22.13+)

```bash
npm run previa        # mostra quem receberia, sem disparar nada
npm run once          # executa um ciclo
npm start             # modo contínuo (a cada INTERVALO_MINUTOS)
npm run relatorio     # situação de cada contato e e-mails monitorados
npm run botconversa:check   # lista fluxos e etiquetas da conta Botconversa
```

Os disparos são comandados pelo painel (veja abaixo). `npm run previa` nunca envia nada.

## Mensagem

- Com `BOTCONVERSA_FLOW_ID` preenchido, o sistema dispara esse fluxo do Botconversa. É a opção recomendada:
  o fluxo aceita botões e pode ser editado pela equipe.
- Sem fluxo, envia o texto de `mensagem.txt`. Esse texto aceita `{{nome}}` e `{{empresa}}`.

## CRM

O webhook recebe um JSON com estes campos: `nome_completo`, `email`, `telefone` (+55…), `whatsapp`, `empresa`,
`origem`, `campanha`, `email_clicado`, `data_clique` (horário de Brasília), `mautic_id` e `observacao`.
Para ver um exemplo, rode `node --env-file=.env src/index.js --payload-exemplo`.

## Painel de acompanhamento

O painel sobe junto com `npm start`. Para abrir só o painel, rode `npm run painel`.
O endereço é `http://localhost:3010`. O usuário e a senha ficam em `PAINEL_USUARIO` e `PAINEL_SENHA`, no `.env`.

O painel mostra:
- quantos contatos clicaram, receberam o WhatsApp e se inscreveram depois do WhatsApp (a conversão);
- quantos estão na fila e quantos ficaram de fora (sem celular ou com falha);
- o funil, os envios por dia e os números de cada e-mail;
- a lista de contatos, com filtro, busca e exportação para planilha (CSV).

Ele se atualiza sozinho a cada minuto.

## Quais e-mails entram no remarketing

A escolha é feita no painel, no quadro **E-mails do remarketing**:
- **"Incluir automaticamente e-mails disparados a partir de [data]":** e-mails [ABRADILAN] cujo primeiro disparo é dessa data em diante entram sozinhos, inclusive os novos.
- **Botão liga/desliga em cada e-mail:** inclui ou exclui aquele e-mail, como exceção à regra da data.

Só recebe o WhatsApp quem clicou em um e-mail incluído. Quem já recebeu não é afetado por mudanças no filtro.
A data inicial vem de `EMAILS_DESDE` no `.env`. Depois de alterada no painel, vale a escolha do painel.

## Disparar pelo painel

No quadro **Envios**, no topo do painel:
- **Enviar agora:** escolha a quantidade (5, 10, 30 ou toda a fila) e clique em **Revisar e enviar**. A lista de quem vai receber aparece para você confirmar. O lote sai em segundo plano, e o andamento aparece na tela.
- **Envios automáticos:** use **Ativar** ou **Pausar**. Quando ativos, a cada `INTERVALO_MINUTOS` o sistema envia para até `MAX_POR_CICLO` contatos da fila, sem pedir confirmação. Só funcionam com `npm start`, não com `npm run painel`.

Ao iniciar, os envios automáticos começam pausados enquanto `DRY_RUN=1`. Depois disso, vale o que foi escolhido no painel.
Antes de cada lote, o sistema relê o formulário 31: quem acabou de se inscrever não recebe.

## Relatório de atividades

O painel registra tudo o que o sistema faz: disparos, negócios no CRM, leituras do Mautic, ações feitas no painel e conversões. Cada falha mostra **em qual serviço aconteceu** (WhatsApp, Botconversa, CRM ou Mautic), a etapa e o motivo, por exemplo "sem conexão", "acesso negado — confira a chave" ou "número recusado (sem WhatsApp)".

No painel dá para filtrar por período, serviço e resultado (só falhas, por exemplo), buscar por contato e exportar a planilha em **⬇ Exportar relatório**.
Falhas de conexão em que o pedido não chegou ao serviço são repetidas sozinhas, até 3 vezes, sem risco de mensagem duplicada.
