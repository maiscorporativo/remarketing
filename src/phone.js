/**
 * Normaliza telefone brasileiro para o formato do WhatsApp (55 + DDD + número).
 * Devolve null se não parecer celular (fixo não tem WhatsApp na grande maioria dos casos).
 */
export function toWhatsapp(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  d = d.replace(/^0+/, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length === 10 && /[6-9]/.test(d[2])) d = d.slice(0, 2) + '9' + d.slice(2); // celular antigo sem o 9
  if (d.length !== 11 || d[2] !== '9') return null;
  if (Number(d.slice(0, 2)) < 11) return null; // DDD inválido
  return '55' + d;
}

/** Últimos 11 dígitos — para comparar telefones escritos de jeitos diferentes */
export const phoneKey = (raw) => {
  const w = toWhatsapp(raw);
  return w ? w.slice(-11) : String(raw || '').replace(/\D/g, '').slice(-10) || null;
};
