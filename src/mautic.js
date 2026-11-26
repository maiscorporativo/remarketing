import { config } from './config.js';

const list = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

async function call(method, path, body) {
  const { url, user, pass } = config.mautic;
  let res;
  for (let tentativa = 1; ; tentativa++) {
    try {
      res = await fetch(`${url}/api${path}`, {
        method,
        headers: {
          authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status >= 500 && tentativa < 3) { await new Promise((r) => setTimeout(r, 2000 * tentativa)); continue; }
      break;
    } catch (e) {
      if (tentativa >= 3) throw new Error(`Mautic inacessível (${e.cause?.code || e.message})`);
      await new Promise((r) => setTimeout(r, 2000 * tentativa));
    }
  }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data || data.errors) {
    const msg = data?.errors?.[0]?.message || text.slice(0, 200);
    throw new Error(`Mautic ${res.status} em ${path.split('?')[0]}: ${msg}`);
  }
  return data;
}
const get = (p) => call('GET', p);

/** Cliques (page_hits vindos de link rastreado de e-mail) com id maior que afterId */
export async function fetchEmailClicks(afterId, desdeData) {
  const out = [];
  let last = afterId;
  for (;;) {
    const q = new URLSearchParams({
      'where[0][col]': 'id', 'where[0][expr]': 'gt', 'where[0][val]': String(last),
      'where[1][col]': 'redirect_id', 'where[1][expr]': 'isNotNull',
      'where[2][col]': 'email_id', 'where[2][expr]': 'isNotNull',
      'where[3][col]': 'date_hit', 'where[3][expr]': 'gte', 'where[3][val]': desdeData,
      'order[0][col]': 'id', 'order[0][dir]': 'ASC',
      limit: '1000',
    });
    const d = await get(`/stats/page_hits?${q}`);
    const rows = list(d.stats);
    out.push(...rows);
    if (rows.length < 1000) break;
    last = Math.max(...rows.map((r) => Number(r.id)));
  }
  return out;
}

export async function getEmailName(id) {
  try { return (await get(`/emails/${id}`)).email?.name ?? ''; }
  catch (e) { if (/404/.test(e.message)) return ''; throw e; }
}

/** Data do primeiro disparo do e-mail (UTC, "AAAA-MM-DD HH:MM:SS") ou null se ainda não foi enviado */
export async function getEmailFirstSend(id) {
  const q = new URLSearchParams({
    'where[0][col]': 'email_id', 'where[0][expr]': 'eq', 'where[0][val]': String(id),
    'where[1][col]': 'date_sent', 'where[1][expr]': 'isNotNull',
    'order[0][col]': 'date_sent', 'order[0][dir]': 'ASC', limit: '1',
  });
  return list((await get(`/stats/email_stats?${q}`)).stats)[0]?.date_sent || null;
}

/** Contatos por id, em lotes */
export async function getContacts(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const q = new URLSearchParams({ 'where[0][col]': 'id', 'where[0][expr]': 'in', 'where[0][val]': chunk.join(','), limit: '50', minimal: 'true' });
    const d = await get(`/contacts?${q}`);
    for (const c of list(d.contacts)) out.set(Number(c.id), c.fields?.all || {});
  }
  return out;
}

/** Todos os envios dos formulários de inscrição */
export async function getFormSubmissions(formId) {
  const out = [];
  for (let start = 0; ; start += 200) {
    const d = await get(`/forms/${formId}/submissions?start=${start}&limit=200`);
    const rows = list(d.submissions);
    out.push(...rows);
    if (rows.length < 200 || start + 200 >= Number(d.total)) break;
  }
  return out;
}

export async function addTag(leadId, tag) {
  if (!tag) return;
  await call('PATCH', `/contacts/${leadId}/edit`, { tags: [tag] });
}
