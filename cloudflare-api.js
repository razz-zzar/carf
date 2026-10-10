// OPS CARF — API online (Cloudflare Worker + base de dados D1)
// Guarda os registos das apps por armazém (polo), para todos os supervisores
// do mesmo armazém verem o que cada um regista.
//
// Como publicar (uma vez, na mesma conta da Cloudflare do eprel-sjt):
// 1. Storage & Databases → D1 → Create database → nome "ops-carf" → Create
// 2. Workers & Pages → Create → Start with Hello World! → nome "ops-carf-api" → Deploy
// 3. Edit code → apagar tudo → colar este ficheiro → Deploy
// 4. No worker: Settings → Bindings → Add → D1 database → nome da variável "DB" → base "ops-carf" → Deploy
// 5. No worker: Settings → Variables and Secrets → Add (tipo Secret):
//      SEGREDO = um texto longo qualquer (ex. 40 letras e números ao calhas) — assina as sessões
//      ADMIN   = o código de administrador da página de gestão (só o Fábio o sabe)
// 6. Testar: https://ops-carf-api.<conta>.workers.dev/ deve mostrar {"ok":true,...}
// As tabelas da base de dados criam-se sozinhas no primeiro pedido.

const VERSAO = 3;
const ORIGENS = [
  "https://razz-zzar.github.io",
  "https://raw.githack.com",
  "https://rawcdn.githack.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];
const APPS = new Set(["pneus", "chegadas", "penalizacoes", "frota", "ocorrencias", "turno"]);
const DIAS_SESSAO = 180;
// Plano gratuito: no máximo 50 consultas à base de dados por pedido. Cada envio de registos usa
// 1 consulta de leitura + 1 por registo, por isso cada envio leva no máximo 20 registos.
const MAX_ITENS = 20, MAX_DADOS = 20000, PAGINA = 500;
const MAX_FOTO = 1500000;
// Campos que se podem alterar sozinhos: "afixada" ou "vistos.<chave>" (letras, números, - e _)
const CAMPO = /^[A-Za-z][A-Za-z0-9_]{0,30}(\.[A-Za-z0-9_-]{1,60})?$/; // bytes (a app reduz as fotografias para ~150-300 KB)

const SQL_TABELAS = [
  `CREATE TABLE IF NOT EXISTS polos (
     id TEXT PRIMARY KEY, nome TEXT NOT NULL, codigo_hash TEXT NOT NULL,
     config TEXT NOT NULL DEFAULT '{}', ordem INTEGER NOT NULL DEFAULT 0,
     ativo INTEGER NOT NULL DEFAULT 1, alterado INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS registos (
     polo TEXT NOT NULL, app TEXT NOT NULL, id TEXT NOT NULL, dia TEXT NOT NULL DEFAULT '',
     dados TEXT NOT NULL, autor TEXT NOT NULL DEFAULT '', autor_disp TEXT NOT NULL DEFAULT '',
     criado INTEGER NOT NULL, alterado INTEGER NOT NULL, alterado_por TEXT NOT NULL DEFAULT '',
     apagado INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (polo, app, id))`,
  `CREATE INDEX IF NOT EXISTS registos_sync ON registos (polo, app, alterado)`,
  `CREATE TABLE IF NOT EXISTS tentativas (chave TEXT NOT NULL, t INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fotos (
     polo TEXT NOT NULL, id TEXT NOT NULL, registo TEXT NOT NULL DEFAULT '', dados BLOB NOT NULL,
     tipo TEXT NOT NULL DEFAULT 'image/jpeg', tamanho INTEGER NOT NULL DEFAULT 0,
     autor_disp TEXT NOT NULL DEFAULT '', criado INTEGER NOT NULL, PRIMARY KEY (polo, id))`,
  `CREATE INDEX IF NOT EXISTS tentativas_chave ON tentativas (chave, t)`,
];
let tabelasProntas = null;
function prepararTabelas(db) {
  if (!tabelasProntas) {
    tabelasProntas = db.batch(SQL_TABELAS.map(s => db.prepare(s))).catch(e => { tabelasProntas = null; throw e; });
  }
  return tabelasProntas;
}

/* ---------- utilitários ---------- */
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
async function sha256(txt) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(txt))); }
async function chaveHmac(segredo) {
  return crypto.subtle.importKey("raw", enc.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function iguais(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
const hashCodigo = (env, polo, codigo) => sha256(polo + ":" + String(codigo).trim() + ":" + env.SEGREDO);
const limpaNome = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 40);
const idPolo = s => /^[a-z0-9][a-z0-9-]{0,29}$/.test(s);

async function criarToken(env, dados) {
  const corpo = b64url(enc.encode(JSON.stringify(dados)));
  const ass = await crypto.subtle.sign("HMAC", await chaveHmac(env.SEGREDO), enc.encode(corpo));
  return corpo + "." + b64url(ass);
}
async function lerToken(env, token) {
  const [corpo, ass] = String(token || "").split(".");
  if (!corpo || !ass) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await chaveHmac(env.SEGREDO), deB64url(ass), enc.encode(corpo)); } catch (e) { return null; }
  if (!ok) return null;
  let d; try { d = JSON.parse(new TextDecoder().decode(deB64url(corpo))); } catch (e) { return null; }
  if (!d || typeof d.e !== "number" || d.e < Date.now()) return null;
  return d;
}

/* ---------- respostas ---------- */
function corsDe(request) {
  const o = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGENS.includes(o) ? o : ORIGENS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const resposta = (cors, obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const erro = (cors, status, codigo, texto) => resposta(cors, { erro: texto, codigo }, status);
const pausa = ms => new Promise(r => setTimeout(r, ms));

/* ---------- sessão ---------- */
async function sessaoDe(request, env) {
  const h = request.headers.get("Authorization") || "";
  const t = await lerToken(env, h.replace(/^Bearer\s+/i, ""));
  if (!t) return null;
  const polo = await env.DB.prepare("SELECT id, nome, codigo_hash, config, ativo FROM polos WHERE id = ?").bind(t.p).first();
  // Se o código do armazém mudar, as sessões antigas deixam de valer
  if (!polo || !polo.ativo || !iguais(polo.codigo_hash.slice(0, 12), t.v)) return null;
  return { polo, disp: t.d, nome: t.n };
}
const configDe = polo => { try { return JSON.parse(polo.config || "{}"); } catch (e) { return {}; } };

async function entrar(request, env, cors) {
  let b; try { b = await request.json(); } catch (e) { return erro(cors, 400, "pedido", "Pedido inválido."); }
  const poloId = String(b.polo || ""), nome = limpaNome(b.nome), disp = String(b.dispositivo || "").slice(0, 64);
  if (!idPolo(poloId) || !nome || disp.length < 8) return erro(cors, 400, "pedido", "Indique o armazém, o código e o seu nome.");
  const ip = request.headers.get("CF-Connecting-IP") || "local", chave = poloId + "|" + ip, desde = Date.now() - 15 * 60000;
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tentativas WHERE chave = ? AND t > ?").bind(chave, desde).first();
  if (n && n.n >= 10) return erro(cors, 429, "tentativas", "Demasiadas tentativas com código errado. Espere 15 minutos.");
  const polo = await env.DB.prepare("SELECT * FROM polos WHERE id = ? AND ativo = 1").bind(poloId).first();
  const h = await hashCodigo(env, poloId, b.codigo);
  if (!polo || !iguais(polo.codigo_hash, h)) {
    await env.DB.prepare("INSERT INTO tentativas (chave, t) VALUES (?, ?)").bind(chave, Date.now()).run();
    await pausa(600);
    return erro(cors, 403, "codigo", "Código errado para este armazém.");
  }
  await env.DB.prepare("DELETE FROM tentativas WHERE chave = ? OR t < ?").bind(chave, desde).run();
  const token = await criarToken(env, { p: polo.id, d: disp, n: nome, v: polo.codigo_hash.slice(0, 12), e: Date.now() + DIAS_SESSAO * 86400000 });
  return resposta(cors, { token, polo: { id: polo.id, nome: polo.nome }, nome, config: configDe(polo) });
}

/* ---------- registos ---------- */
function paraCliente(r, disp) {
  let dados = {}; try { dados = JSON.parse(r.dados); } catch (e) {}
  return { id: r.id, dia: r.dia, dados, autor: r.autor, alteradoPor: r.alterado_por, meu: r.autor_disp === disp,
           criado: r.criado, alterado: r.alterado, apagado: !!r.apagado };
}

async function listar(url, env, cors, s) {
  const app = url.searchParams.get("app");
  if (!APPS.has(app)) return erro(cors, 400, "app", "App desconhecida.");
  const desde = Math.max(0, parseInt(url.searchParams.get("desde") || "0", 10) || 0);
  const r = await env.DB.prepare(
    "SELECT * FROM registos WHERE polo = ? AND app = ? AND alterado >= ? ORDER BY alterado, id LIMIT ?"
  ).bind(s.polo.id, app, desde, PAGINA + 1).all();
  const linhas = r.results || [];
  const mais = linhas.length > PAGINA;
  return resposta(cors, { registos: linhas.slice(0, PAGINA).map(x => paraCliente(x, s.disp)), mais, agora: Date.now() });
}

async function gravar(request, env, cors, s) {
  let b; try { b = await request.json(); } catch (e) { return erro(cors, 400, "pedido", "Pedido inválido."); }
  const app = b.app, itens = Array.isArray(b.itens) ? b.itens : [];
  if (!APPS.has(app)) return erro(cors, 400, "app", "App desconhecida.");
  if (!itens.length || itens.length > MAX_ITENS) return erro(cors, 400, "pedido", "Envie entre 1 e " + MAX_ITENS + " registos de cada vez.");
  const ids = [...new Set(itens.map(it => String(it && it.id || "")).filter(id => id && id.length <= 100))];
  const atuais = new Map();
  if (ids.length) {
    const r = await env.DB.prepare("SELECT * FROM registos WHERE polo = ? AND app = ? AND id IN (" + ids.map(() => "?").join(",") + ")")
      .bind(s.polo.id, app, ...ids).all();
    for (const x of r.results || []) atuais.set(x.id, x);
  }
  const resultados = [];
  let agora = Date.now();
  for (const it of itens) {
    const id = String(it && it.id || "");
    if (!id || id.length > 100) { resultados.push({ id, ok: false, codigo: "id" }); continue; }
    const atual = atuais.get(id);
    const t = agora++;
    let depois;
    if (it.campos && typeof it.campos === "object" && !it.apagado) {
      // Altera só alguns campos (ex. "visto por", afixar), sem reescrever o resto: duas pessoas
      // a marcar ao mesmo tempo não apagam a marca uma da outra.
      if (!atual || atual.apagado) { resultados.push({ id, ok: false, codigo: "nao_existe" }); continue; }
      const pares = Object.entries(it.campos).slice(0, 10).filter(([k]) => CAMPO.test(k));
      if (!pares.length) { resultados.push({ id, ok: false, codigo: "campos" }); continue; }
      let expr = "dados"; const args = [];
      for (const [k, v] of pares) {
        const caminho = "$" + k.split(".").map(x => '."' + x + '"').join("");
        if (v === null) { expr = "json_remove(" + expr + ", ?)"; args.push(caminho); }
        else { expr = "json_set(" + expr + ", ?, json(?))"; args.push(caminho, JSON.stringify(v)); }
      }
      if (args.reduce((n, a) => n + String(a).length, 0) + String(atual.dados).length > MAX_DADOS) { resultados.push({ id, ok: false, codigo: "grande" }); continue; }
      depois = await env.DB.prepare("UPDATE registos SET dados = " + expr + ", alterado = ?, alterado_por = ? WHERE polo = ? AND app = ? AND id = ? AND apagado = 0 RETURNING *")
        .bind(...args, t, atual.alterado_por, s.polo.id, app, id).first();
    } else if (it.apagado) {
      if (!atual || atual.apagado) { resultados.push({ id, ok: true, registo: atual ? paraCliente(atual, s.disp) : null }); continue; }
      if (atual.autor_disp !== s.disp) { resultados.push({ id, ok: false, codigo: "so_autor", registo: paraCliente(atual, s.disp) }); continue; }
      depois = await env.DB.prepare("UPDATE registos SET apagado = 1, alterado = ?, alterado_por = ? WHERE polo = ? AND app = ? AND id = ? RETURNING *")
        .bind(t, s.nome, s.polo.id, app, id).first();
    } else {
      const dados = JSON.stringify(it.dados && typeof it.dados === "object" ? it.dados : {});
      const dia = /^\d{4}-\d{2}-\d{2}$/.test(it.dia || "") ? it.dia : "";
      if (dados.length > MAX_DADOS) { resultados.push({ id, ok: false, codigo: "grande" }); continue; }
      const criado = Number.isFinite(it.criado) && it.criado > 0 && it.criado <= t ? Math.floor(it.criado) : t;
      if (!atual || atual.apagado) {
        // Novo (ou de novo depois de apagado): fica com o nome de quem o regista agora
        depois = await env.DB.prepare(
          `INSERT INTO registos (polo, app, id, dia, dados, autor, autor_disp, criado, alterado, alterado_por, apagado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)
           ON CONFLICT (polo, app, id) DO UPDATE SET dia = excluded.dia, dados = excluded.dados, autor = excluded.autor,
             autor_disp = excluded.autor_disp, criado = excluded.criado, alterado = excluded.alterado, alterado_por = '', apagado = 0
           RETURNING *`
        ).bind(s.polo.id, app, id, dia, dados, s.nome, s.disp, criado, t).first();
      } else {
        // Alteração de um registo que já existe (ex. km da viatura, ocorrência resolvida): mantém o autor
        depois = await env.DB.prepare("UPDATE registos SET dia = ?, dados = ?, alterado = ?, alterado_por = ? WHERE polo = ? AND app = ? AND id = ? RETURNING *")
          .bind(dia, dados, t, atual.autor_disp === s.disp ? "" : s.nome, s.polo.id, app, id).first();
      }
    }
    if (depois) atuais.set(id, depois);
    resultados.push({ id, ok: true, registo: depois ? paraCliente(depois, s.disp) : null });
  }
  return resposta(cors, { resultados, agora: Date.now() });
}

/* ---------- fotografias (guardadas na base de dados, por polo) ---------- */
const idFoto = s => /^[A-Za-z0-9_-]{8,80}$/.test(s);
async function enviarFoto(request, url, env, cors, s) {
  const id = url.searchParams.get("id") || "", registo = String(url.searchParams.get("registo") || "").slice(0, 100);
  if (!idFoto(id)) return erro(cors, 400, "id", "Identificador de fotografia inválido.");
  const tipo = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(tipo)) return erro(cors, 400, "tipo", "Só são aceites fotografias (JPEG, PNG ou WebP).");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return erro(cors, 400, "vazia", "Fotografia vazia.");
  if (bytes.length > MAX_FOTO) return erro(cors, 413, "grande", "Fotografia demasiado grande.");
  // Se já existir (reenvio depois de falha de rede), não volta a gravar
  await env.DB.prepare(
    "INSERT INTO fotos (polo, id, registo, dados, tipo, tamanho, autor_disp, criado) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (polo, id) DO NOTHING"
  ).bind(s.polo.id, id, registo, bytes, tipo, bytes.length, s.disp, Date.now()).run();
  return resposta(cors, { ok: true, id, tamanho: bytes.length });
}
async function lerFoto(id, env, cors, s) {
  if (!idFoto(id)) return erro(cors, 400, "id", "Identificador de fotografia inválido.");
  const f = await env.DB.prepare("SELECT dados, tipo FROM fotos WHERE polo = ? AND id = ?").bind(s.polo.id, id).first();
  if (!f) return erro(cors, 404, "foto", "Fotografia não encontrada.");
  const d = f.dados instanceof ArrayBuffer ? new Uint8Array(f.dados) : new Uint8Array(f.dados);
  return new Response(d, { headers: { ...cors, "Content-Type": f.tipo, "Cache-Control": "private, max-age=31536000, immutable" } });
}
async function apagarFotos(request, env, cors, s) {
  let b; try { b = await request.json(); } catch (e) { return erro(cors, 400, "pedido", "Pedido inválido."); }
  const ids = (Array.isArray(b.ids) ? b.ids : []).filter(idFoto).slice(0, 40);
  if (!ids.length) return resposta(cors, { ok: true, apagadas: 0 });
  // Só quem tirou a fotografia a pode apagar
  const r = await env.DB.prepare("DELETE FROM fotos WHERE polo = ? AND autor_disp = ? AND id IN (" + ids.map(() => "?").join(",") + ")")
    .bind(s.polo.id, s.disp, ...ids).run();
  return resposta(cors, { ok: true, apagadas: (r.meta && r.meta.changes) || 0 });
}

/* ---------- gestão (só com o código de administrador) ---------- */
async function gestao(request, url, env, cors) {
  if (!env.ADMIN || !iguais(request.headers.get("X-Admin") || "", env.ADMIN)) {
    await pausa(600);
    return erro(cors, 403, "admin", "Código de administrador errado.");
  }
  if (request.method === "GET") {
    const r = await env.DB.prepare("SELECT id, nome, config, ordem, ativo, alterado FROM polos ORDER BY ordem, nome").all();
    const f = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(tamanho), 0) AS bytes FROM fotos").first();
    return resposta(cors, { polos: (r.results || []).map(p => ({ ...p, config: configDe(p), ativo: !!p.ativo })),
      fotos: { n: (f && f.n) || 0, bytes: (f && f.bytes) || 0 } });
  }
  let b; try { b = await request.json(); } catch (e) { return erro(cors, 400, "pedido", "Pedido inválido."); }
  const id = String(b.id || "").toLowerCase().trim(), nome = limpaNome(b.nome);
  if (!idPolo(id)) return erro(cors, 400, "id", "Identificador inválido: só letras minúsculas, números e hífen (ex. sjt, leiria).");
  if (!nome) return erro(cors, 400, "nome", "Falta o nome do armazém.");
  const config = JSON.stringify(b.config && typeof b.config === "object" ? b.config : {});
  if (config.length > 100000) return erro(cors, 400, "config", "Listas demasiado grandes.");
  const atual = await env.DB.prepare("SELECT id FROM polos WHERE id = ?").bind(id).first();
  const codigo = String(b.codigo || "").trim();
  if (!atual && codigo.length < 4) return erro(cors, 400, "codigo", "Defina um código com pelo menos 4 caracteres.");
  if (codigo && codigo.length < 4) return erro(cors, 400, "codigo", "O código tem de ter pelo menos 4 caracteres.");
  const ordem = Number.isFinite(b.ordem) ? Math.floor(b.ordem) : 0, ativo = b.ativo === false ? 0 : 1, t = Date.now();
  if (!atual) {
    await env.DB.prepare("INSERT INTO polos (id, nome, codigo_hash, config, ordem, ativo, alterado) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, nome, await hashCodigo(env, id, codigo), config, ordem, ativo, t).run();
  } else if (codigo) {
    await env.DB.prepare("UPDATE polos SET nome = ?, codigo_hash = ?, config = ?, ordem = ?, ativo = ?, alterado = ? WHERE id = ?")
      .bind(nome, await hashCodigo(env, id, codigo), config, ordem, ativo, t, id).run();
  } else {
    await env.DB.prepare("UPDATE polos SET nome = ?, config = ?, ordem = ?, ativo = ?, alterado = ? WHERE id = ?")
      .bind(nome, config, ordem, ativo, t, id).run();
  }
  return resposta(cors, { ok: true, id, novo: !atual, codigoMudou: !!(atual && codigo) });
}

/* ---------- entrada ---------- */
export default {
  async fetch(request, env) {
    const cors = corsDe(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url), caminho = url.pathname.replace(/\/+$/, "") || "/";
    if (!env.DB || !env.SEGREDO || !env.ADMIN) {
      const falta = [!env.DB && "a base de dados DB", !env.SEGREDO && "o segredo SEGREDO", !env.ADMIN && "o código ADMIN"].filter(Boolean);
      return erro(cors, 500, "configuracao", "Falta configurar no Cloudflare: " + falta.join(", ") + ".");
    }
    try {
      await prepararTabelas(env.DB);
      if (caminho === "/" && request.method === "GET") return resposta(cors, { ok: true, servico: "ops-carf-api", versao: VERSAO });
      if (caminho === "/polos" && request.method === "GET") {
        const r = await env.DB.prepare("SELECT id, nome FROM polos WHERE ativo = 1 ORDER BY ordem, nome").all();
        return resposta(cors, { polos: r.results || [] });
      }
      if (caminho === "/entrar" && request.method === "POST") return await entrar(request, env, cors);
      if (caminho === "/gestao/polos" && (request.method === "GET" || request.method === "POST")) return await gestao(request, url, env, cors);
      const s = await sessaoDe(request, env);
      if (!s) return erro(cors, 401, "sessao", "Sessão expirada ou código do armazém alterado. Entre de novo.");
      if (caminho === "/sessao" && request.method === "GET")
        return resposta(cors, { polo: { id: s.polo.id, nome: s.polo.nome }, nome: s.nome, config: configDe(s.polo) });
      if (caminho === "/registos" && request.method === "GET") return await listar(url, env, cors, s);
      if (caminho === "/registos" && request.method === "POST") return await gravar(request, env, cors, s);
      if (caminho === "/fotos" && request.method === "POST") return await enviarFoto(request, url, env, cors, s);
      if (caminho === "/fotos/apagar" && request.method === "POST") return await apagarFotos(request, env, cors, s);
      if (caminho.startsWith("/fotos/") && request.method === "GET") return await lerFoto(decodeURIComponent(caminho.slice(7)), env, cors, s);
      return erro(cors, 404, "caminho", "Caminho desconhecido.");
    } catch (e) {
      return erro(cors, 500, "interno", "Erro no servidor: " + (e && e.message || e));
    }
  },
};
