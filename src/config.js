const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  mautic: {
    url: (env.MAUTIC_URL || '').replace(/\/+$/, '').replace(/\/api$/, ''),
    user: env.MAUTIC_USER || '',
    pass: env.MAUTIC_PASS || '',
    tag: env.MAUTIC_TAG ?? 'abradilan-remarketing-whatsapp',
  },
  emailNamePattern: new RegExp(env.EMAIL_NAME_PATTERN || '^\\s*\\[ABRADILAN\\]', 'i'),
  // valor inicial do filtro de e-mails (depois é escolhido no painel)
  emailsDesde: /^\d{4}-\d{2}-\d{2}$/.test(env.EMAILS_DESDE || '') ? env.EMAILS_DESDE : '',
  siteUrlPattern: env.SITE_URL_PATTERN || 'abradilan.mais.tur.br',
  formIds: (env.FORM_IDS || '31').split(',').map((x) => Number(x.trim())).filter(Boolean),
  delayMin: num(env.DELAY_MINUTOS, 120),
  janelaDias: num(env.JANELA_DIAS, 30),
  intervaloMin: Math.max(2, num(env.INTERVALO_MINUTOS, 15)),
  maxPorCiclo: num(env.MAX_POR_CICLO, 30),
  pausaSeg: num(env.PAUSA_ENTRE_ENVIOS, 8),
  dryRun: /^(1|true|sim)$/i.test(env.DRY_RUN ?? '1'),
  botconversa: {
    apiKey: env.BOTCONVERSA_API_KEY || '',
    flowId: env.BOTCONVERSA_FLOW_ID || '',
    tagId: env.BOTCONVERSA_TAG_ID || '',
    webhookUrl: env.BOTCONVERSA_WEBHOOK_URL || '',
  },
  crmWebhookUrl: env.CRM_WEBHOOK_URL || '',
};

export function checkConfig({ needSenders }) {
  const errs = [];
  if (!config.mautic.url || !config.mautic.user || !config.mautic.pass) errs.push('Preencha MAUTIC_URL, MAUTIC_USER e MAUTIC_PASS no .env');
  if (needSenders) {
    const b = config.botconversa;
    if (!b.webhookUrl && !b.apiKey) errs.push('Botconversa: preencha BOTCONVERSA_API_KEY (ou BOTCONVERSA_WEBHOOK_URL)');
    if (!config.crmWebhookUrl) errs.push('Preencha CRM_WEBHOOK_URL');
  }
  return errs;
}
