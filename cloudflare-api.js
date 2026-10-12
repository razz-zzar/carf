// OPS CARF — API online (Cloudflare Worker + base de dados D1)
// Guarda os registos das apps por armazém (polo), para todos os supervisores
// do mesmo armazém verem o que cada um regista.
//
// Como publicar (uma vez, na mesma conta da Cloudflare do eprel-carf):
// 1. Storage & Databases → D1 → Create database → nome "ops-carf" → Create
// 2. Workers & Pages → Create → Start with Hello World! → nome "ops-carf-api" → Deploy
// 3. Edit code → apagar tudo → colar este ficheiro → Deploy
// 4. No worker: Settings → Bindings → Add → D1 database → nome da variável "DB" → base "ops-carf" → Deploy
// 5. No worker: Settings → Variables and Secrets → Add (tipo Secret):
//      SEGREDO = um texto longo qualquer (ex. 40 letras e números ao calhas) — assina as sessões
//      ADMIN   = o código de administrador da página de gestão (só o Fábio o sabe)
// 6. Fotografias no R2 (recomendado; sem isto ficam na base de dados D1, que tem só 500 MB):
//      R2 → Create bucket → nome "ops-carf-fotos" → Create
//      No worker: Settings → Bindings → Add → R2 bucket → nome da variável "FOTOS" → bucket "ops-carf-fotos" → Deploy
// 7. Resumo do dia com IA (Mural → "Resumo do dia"; grátis até ~60 resumos/dia no plano gratuito):
//      No worker: Settings → Bindings → Add → Workers AI → nome da variável "AI" → Deploy
// 8. Testar: https://ops-carf-api.<conta>.workers.dev/ deve mostrar {"ok":true,...} ("fotos":"r2" se o R2 estiver ligado)
// As tabelas da base de dados criam-se sozinhas no primeiro pedido.

const VERSAO = 10;
const ORIGENS = [
  "https://razz-zzar.github.io",
  "https://raw.githack.com",
  "https://rawcdn.githack.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];
const APPS = new Set(["pneus", "chegadas", "penalizacoes", "frota", "ocorrencias", "contactos", "turno", "codigos"]);
// Apps partilhadas por TODOS os armazéns (ex. códigos de pneus aprendidos): guardadas no polo "*"
const GLOBAIS = new Set(["codigos"]);
const poloDe = (app, s) => GLOBAIS.has(app) ? "*" : s.polo.id;
// Apps em que qualquer supervisor do polo pode apagar (nas outras só quem registou)
const TODOS_APAGAM = new Set(["frota"]);
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
  // limpezas feitas na gestão, por polo ("*" = códigos/opções partilhados): {app: {t, de, ate}}
  // os telemóveis esquecem a cópia local dessa app e o servidor recusa registos antigos desse período por enviar
  `CREATE TABLE IF NOT EXISTS limpezas_app (polo TEXT PRIMARY KEY, dados TEXT NOT NULL DEFAULT '{}')`,
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
  ).bind(poloDe(app, s), app, desde, PAGINA + 1).all();
  const linhas = r.results || [];
  const mais = linhas.length > PAGINA;
  const lp = await limpezaDe(env, poloDe(app, s), app);
  return resposta(cors, { registos: linhas.slice(0, PAGINA).map(x => paraCliente(x, s.disp)), mais, agora: Date.now(), limpeza: lp ? lp.t : 0 });
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
      .bind(poloDe(app, s), app, ...ids).all();
    for (const x of r.results || []) atuais.set(x.id, x);
  }
  const resultados = [];
  let agora = Date.now();
  const limpeza = await limpezaDe(env, poloDe(app, s), app);
  for (const it of itens) {
    const id = String(it && it.id || "");
    if (!id || id.length > 100) { resultados.push({ id, ok: false, codigo: "id" }); continue; }
    const atual = atuais.get(id);
    const t = agora++;
    let depois;
    // registo feito antes de uma limpeza de dados de teste e que já não existe: não volta a aparecer
    if (limpeza && !it.apagado && (!atual || atual.apagado) && Number(it.criado) > 0 && Number(it.criado) < limpeza.t) {
      const d = diaDoRegisto(it.dia, it.criado);
      if ((!limpeza.de || d >= limpeza.de) && (!limpeza.ate || d <= limpeza.ate)) { resultados.push({ id, ok: false, codigo: "limpo" }); continue; }
    }
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
        .bind(...args, t, atual.alterado_por, poloDe(app, s), app, id).first();
    } else if (it.apagado) {
      if (!atual || atual.apagado) { resultados.push({ id, ok: true, registo: atual ? paraCliente(atual, s.disp) : null }); continue; }
      if (atual.autor_disp !== s.disp && !TODOS_APAGAM.has(app)) { resultados.push({ id, ok: false, codigo: "so_autor", registo: paraCliente(atual, s.disp) }); continue; }
      depois = await env.DB.prepare("UPDATE registos SET apagado = 1, alterado = ?, alterado_por = ? WHERE polo = ? AND app = ? AND id = ? RETURNING *")
        .bind(t, s.nome, poloDe(app, s), app, id).first();
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
        ).bind(poloDe(app, s), app, id, dia, dados, s.nome, s.disp, criado, t).first();
      } else {
        // Alteração de um registo que já existe (ex. km da viatura, ocorrência resolvida): mantém o autor
        depois = await env.DB.prepare("UPDATE registos SET dia = ?, dados = ?, alterado = ?, alterado_por = ? WHERE polo = ? AND app = ? AND id = ? RETURNING *")
          .bind(dia, dados, t, atual.autor_disp === s.disp ? "" : s.nome, poloDe(app, s), app, id).first();
      }
    }
    if (depois) atuais.set(id, depois);
    resultados.push({ id, ok: true, registo: depois ? paraCliente(depois, s.disp) : null });
  }
  return resposta(cors, { resultados, agora: Date.now() });
}

/* ---------- limpezas (ver gestaoLimpar) ---------- */
async function limpezaDe(env, polo, app) {
  const r = await env.DB.prepare("SELECT dados FROM limpezas_app WHERE polo = ?").bind(polo).first();
  if (!r) return null;
  try { return JSON.parse(r.dados)[app] || null; } catch (e) { return null; }
}
const diaDoRegisto = (dia, criado) => /^\d{4}-\d{2}-\d{2}$/.test(dia || "") ? dia : new Date(Number(criado) || 0).toISOString().slice(0, 10);

/* ---------- fotografias ----------
   Com o R2 ligado (binding FOTOS) os ficheiros ficam no R2 e a tabela "fotos" guarda só os dados da fotografia
   (dados vazio). Sem R2 ficam dentro da base de dados, como antes. As antigas passam para o R2 quando são vistas. */
const idFoto = s => /^[A-Za-z0-9_-]{8,80}$/.test(s);
const chaveR2 = (polo, id) => polo + "/" + id;
async function enviarFoto(request, url, env, cors, s) {
  const id = url.searchParams.get("id") || "", registo = String(url.searchParams.get("registo") || "").slice(0, 100);
  if (!idFoto(id)) return erro(cors, 400, "id", "Identificador de fotografia inválido.");
  const tipo = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(tipo)) return erro(cors, 400, "tipo", "Só são aceites fotografias (JPEG, PNG ou WebP).");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return erro(cors, 400, "vazia", "Fotografia vazia.");
  if (bytes.length > MAX_FOTO) return erro(cors, 413, "grande", "Fotografia demasiado grande.");
  // Se já existir (reenvio depois de falha de rede), não volta a gravar
  const ja = await env.DB.prepare("SELECT 1 AS x FROM fotos WHERE polo = ? AND id = ?").bind(s.polo.id, id).first();
  if (ja) return resposta(cors, { ok: true, id, tamanho: bytes.length });
  if (env.FOTOS) await env.FOTOS.put(chaveR2(s.polo.id, id), bytes, { httpMetadata: { contentType: tipo } });
  await env.DB.prepare(
    "INSERT INTO fotos (polo, id, registo, dados, tipo, tamanho, autor_disp, criado) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (polo, id) DO NOTHING"
  ).bind(s.polo.id, id, registo, env.FOTOS ? new Uint8Array(0) : bytes, tipo, bytes.length, s.disp, Date.now()).run();
  return resposta(cors, { ok: true, id, tamanho: bytes.length });
}
async function lerFoto(id, env, cors, s) {
  if (!idFoto(id)) return erro(cors, 400, "id", "Identificador de fotografia inválido.");
  const cab = t => ({ ...cors, "Content-Type": t, "Cache-Control": "private, max-age=31536000, immutable" });
  const f = await env.DB.prepare("SELECT tipo, length(dados) AS n FROM fotos WHERE polo = ? AND id = ?").bind(s.polo.id, id).first();
  if (!f) return erro(cors, 404, "foto", "Fotografia não encontrada.");
  if (!f.n) {
    // está no R2
    const o = env.FOTOS ? await env.FOTOS.get(chaveR2(s.polo.id, id)) : null;
    if (!o) return erro(cors, 404, "foto", "Fotografia não encontrada.");
    return new Response(o.body, { headers: cab(f.tipo) });
  }
  const g = await env.DB.prepare("SELECT dados FROM fotos WHERE polo = ? AND id = ?").bind(s.polo.id, id).first();
  const d = new Uint8Array(g.dados);
  if (env.FOTOS) {
    // fotografia antiga guardada na base de dados: passa para o R2 e liberta o espaço
    await env.FOTOS.put(chaveR2(s.polo.id, id), d, { httpMetadata: { contentType: f.tipo } });
    await env.DB.prepare("UPDATE fotos SET dados = ? WHERE polo = ? AND id = ?").bind(new Uint8Array(0), s.polo.id, id).run();
  }
  return new Response(d, { headers: cab(f.tipo) });
}
async function apagarFotos(request, env, cors, s) {
  let b; try { b = await request.json(); } catch (e) { return erro(cors, 400, "pedido", "Pedido inválido."); }
  const ids = (Array.isArray(b.ids) ? b.ids : []).filter(idFoto).slice(0, 40);
  if (!ids.length) return resposta(cors, { ok: true, apagadas: 0 });
  // Só quem tirou a fotografia a pode apagar
  const marcas = ids.map(() => "?").join(",");
  const minhas = await env.DB.prepare("SELECT id FROM fotos WHERE polo = ? AND autor_disp = ? AND id IN (" + marcas + ")").bind(s.polo.id, s.disp, ...ids).all();
  const lista = (minhas.results || []).map(x => x.id);
  if (!lista.length) return resposta(cors, { ok: true, apagadas: 0 });
  if (env.FOTOS) await env.FOTOS.delete(lista.map(x => chaveR2(s.polo.id, x)));
  const r = await env.DB.prepare("DELETE FROM fotos WHERE polo = ? AND id IN (" + lista.map(() => "?").join(",") + ")").bind(s.polo.id, ...lista).run();
  return resposta(cors, { ok: true, apagadas: (r.meta && r.meta.changes) || 0 });
}

/* ---------- gestão (só com o código de administrador) ---------- */
// Limpar dados antigos ou de teste, um polo de cada vez (limite de consultas do plano gratuito):
// {polo: "sjt" | "*", apps: ["pneus", ...], de: "AAAA-MM-DD"?, ate: "AAAA-MM-DD"?, simular: true?}
// O dia de cada registo é o seu campo "dia" (ou a data em que foi criado). "simular" só conta o que seria apagado.
// Marca os registos como apagados (os telemóveis recebem a limpeza) e apaga as fotografias desses registos.
/* ---------- Resumo do dia (Mural) ----------
   Os números calculam-se aqui, a partir dos registos do armazém nesse dia; a IA (Workers AI) só escreve o texto.
   Sem IA ligada (ou sem quota), devolve o resumo simples feito só com os números. */
const MODELOS_IA = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8"];
const FMT_LX = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function lisboa(iso) {
  const d = new Date(iso); if (isNaN(d)) return null;
  const p = Object.fromEntries(FMT_LX.formatToParts(d).map(x => [x.type, x.value]));
  return { dia: p.year + "-" + p.month + "-" + p.day, hora: p.hour + ":" + p.minute, min: +p.hour * 60 + +p.minute };
}
/* Limite de pedidos por chave numa janela (usa a tabela das tentativas) */
async function bloqueado(env, chave, max, janelaSeg) {
  const desde = Date.now() - janelaSeg * 1000;
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tentativas WHERE chave = ? AND t > ?").bind(chave, desde).first();
  if (n && n.n >= max) return true;
  await env.DB.prepare("INSERT INTO tentativas (chave, t) VALUES (?, ?)").bind(chave, Date.now()).run();
  return false;
}
const eur = n => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",") + " €";
const corta = (t, n) => { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
function factosDoDia(dia, cfg, linhas) {
  const por = {}; for (const l of linhas) { let d = {}; try { d = JSON.parse(l.dados); } catch (e) {} (por[l.app] = por[l.app] || []).push({ ...d, _autor: l.autor, _dia: l.dia }); }
  const F = [], atencao = [];
  const temDia = linhas.some(l => l.app !== "frota" && l.dia === dia && !(l.app === "turno" && /"k":"p"/.test(l.dados)));
  if (!temDia) return { factos: [], atencao: [] };
  // Horários
  const voltasC = (cfg.voltasC || []).map(String), voltasS = (cfg.voltasS || []).map(String), extra = new Set((cfg.interruptor || []).map(String)), prev = cfg.previsoes || {};
  const ch = {}, sa = {}; for (const r of (por.chegadas || [])) { if (r._dia !== dia || !r.volta) continue; (r.modo === "s" ? sa : ch)[String(r.volta)] = r.t; }
  if (voltasC.length || Object.keys(ch).length) {
    const contaC = voltasC.filter(v => !extra.has(v)), chegaram = contaC.filter(v => ch[v]), faltam = contaC.filter(v => !ch[v]);
    F.push("Chegadas: " + chegaram.length + " de " + contaC.length + " voltas." + (faltam.length ? " Sem chegada registada: " + faltam.join(", ") + "." : ""));
    const atr = [];
    for (const v of Object.keys(ch)) { const p = /^(\d{1,2}):(\d{2})$/.exec(prev[v] || ""), lx = lisboa(ch[v]); if (!p || !lx) continue;
      const x = lx.min - (+p[1] * 60 + +p[2]); if (x > 5) atr.push({ v, x, h: lx.hora, p: prev[v] }); }
    atr.sort((a, b) => b.x - a.x);
    if (atr.length) { F.push("Voltas atrasadas (mais de 5 min): " + atr.map(a => a.v + " chegou " + a.h + ", prevista " + a.p + " (+" + a.x + " min)").join("; ") + ".");
      atencao.push(atr.length + " volta" + (atr.length > 1 ? "s" : "") + " atrasada" + (atr.length > 1 ? "s" : "")); }
    if (faltam.length) atencao.push(faltam.length + " volta" + (faltam.length > 1 ? "s" : "") + " sem chegada registada");
  }
  if (voltasS.length || Object.keys(sa).length) {
    const sairam = voltasS.filter(v => sa[v]), semS = voltasS.filter(v => !sa[v]);
    F.push("Saídas: " + sairam.length + " de " + voltasS.length + " voltas." + (semS.length ? " Sem saída registada: " + semS.join(", ") + "." : ""));
  }
  // Incompletos (pneus em falta)
  const pn = (por.pneus || []).filter(r => r._dia === dia);
  if (pn.length) {
    const porV = {}; for (const r of pn) { const k = r.volta || "?"; (porV[k] = porV[k] || []).push((+r.qtd || 1) + "× " + [r.marca, r.medida].filter(Boolean).join(" ")); }
    const tot = pn.reduce((a, r) => a + (+r.qtd || 1), 0);
    F.push("Pneus em falta (incompletos): " + tot + " pneu" + (tot > 1 ? "s" : "") + " — " + Object.entries(porV).map(([v, l]) => "volta " + v + ": " + l.join(", ")).join("; ") + ".");
  }
  // Penalizações
  const pe = (por.penalizacoes || []).filter(r => r._dia === dia);
  if (pe.length) {
    const soma = pe.reduce((a, r) => a + (typeof r.valor === "number" ? r.valor : 0), 0);
    F.push("Penalizações: " + pe.length + ", total " + eur(soma) + ". " + pe.map(r => "volta " + (r.volta || "?") + (r.sub ? " (" + r.sub + ")" : "") + ": " + corta(r.motivo, 60) + " — " + (typeof r.valor === "number" ? eur(r.valor) : (r.valor || "sem valor")) + (r.motorista ? ", motorista " + r.motorista : "")).join("; ") + ".");
  }
  // Ocorrências
  const oc = (por.ocorrencias || []).filter(r => r._dia === dia);
  if (oc.length) {
    const ab = oc.filter(r => r.estado !== "resolvida");
    F.push("Ocorrências registadas: " + oc.length + (ab.length ? " (" + ab.length + (ab.length > 1 ? " ainda abertas)" : " ainda aberta)") : " (todas resolvidas)") + ". " + oc.map(r => (r.tipo || "Ocorrência") + " — guia " + (r.guia || "?") + (r.cliente ? ", " + r.cliente : "") + (r.estado === "resolvida" ? " (resolvida)" : " (aberta)")).join("; ") + ".");
    if (ab.length) atencao.push(ab.length + " ocorrência" + (ab.length > 1 ? "s" : "") + " aberta" + (ab.length > 1 ? "s" : ""));
  }
  // Pedidos de contacto
  const co = (por.contactos || []).filter(r => r._dia === dia);
  if (co.length) {
    const pend = co.filter(r => r.estado !== "resolvido");
    F.push("Pedidos de contacto: " + co.length + (pend.length ? " (" + pend.length + " à espera de contacto: guia" + (pend.length > 1 ? "s " : " ") + pend.map(r => r.guia).join(", ") + ")" : " (todos com contacto recebido)") + ".");
    if (pend.length) atencao.push(pend.length + " pedido" + (pend.length > 1 ? "s" : "") + " de contacto pendente" + (pend.length > 1 ? "s" : ""));
  }
  // Frota: viaturas na oficina nesse dia (entraram até esse dia e ainda lá estão)
  const fr = por.frota || [], id2 = {}; for (const v of fr) if (v.id) id2[v.id] = v;
  const of = fr.filter(v => v.oficina && v.oficina.desde && (lisboa(v.oficina.desde) || {}).dia <= dia);
  if (of.length) {
    F.push("Viaturas na oficina: " + of.map(v => { const c = v.oficina.cortesia && id2[v.oficina.cortesia]; const d = lisboa(v.oficina.desde);
      return v.matricula + " (" + (v.marca || "") + ", desde " + (d ? d.dia.slice(8) + "/" + d.dia.slice(5, 7) : "?") + (c ? ", carro de cortesia " + c.matricula : ", sem carro de cortesia") + ")"; }).join("; ") + ".");
    atencao.push(of.length + " viatura" + (of.length > 1 ? "s" : "") + " na oficina");
  }
  // Mural: mensagens desse dia (sem resumos anteriores)
  const mu = (por.turno || []).filter(r => r._dia === dia && r.k === "m" && !r.resumo);
  if (mu.length) {
    const imp = mu.filter(r => r.importante || r.afixada);
    const outras = mu.filter(r => !(r.importante || r.afixada)).slice(-10);
    F.push("Mensagens no Mural: " + mu.length + ". " + (imp.length ? "Importantes/afixadas: " + imp.slice(0, 8).map(r => "«" + corta(r.texto, 160) + "» (" + (r._autor || "?") + ")").join("; ") + ". " : "") +
      (outras.length ? "Outras: " + outras.map(r => "«" + corta(r.texto, 120) + "»").join("; ") + "." : ""));
  }
  return { factos: F, atencao };
}
function resumoSimples(titulo, f) {
  if (!f.factos.length) return titulo + "\nSem registos neste dia.";
  return titulo + "\n" + (f.atencao.length ? "Atenção: " + f.atencao.join(", ") + ".\n" : "") + f.factos.map(x => "• " + x).join("\n");
}
async function resumoDia(request, env, cors, s) {
  let b; try { b = await request.json(); } catch (e) { return erro(cors, 400, "pedido", "Pedido inválido."); }
  const dia = String(b.dia || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return erro(cors, 400, "dia", "Dia inválido.");
  if (await bloqueado(env, "resumo:" + s.polo.id, 12, 900)) return erro(cors, 429, "limite", "Demasiados resumos pedidos nos últimos 15 minutos. Tente daqui a pouco.");
  const r = await env.DB.prepare(
    "SELECT app, dia, dados, autor FROM registos WHERE polo = ? AND apagado = 0 AND app IN ('chegadas','pneus','penalizacoes','ocorrencias','contactos','turno','frota') AND (dia = ? OR app = 'frota') LIMIT 3000"
  ).bind(s.polo.id, dia).all();
  const cfg = configDe(s.polo), f = factosDoDia(dia, cfg, r.results || []);
  const titulo = "Resumo de " + dia.slice(8) + "/" + dia.slice(5, 7) + "/" + dia.slice(0, 4) + " — " + s.polo.nome;
  const simples = resumoSimples(titulo, f);
  if (!f.factos.length) return resposta(cors, { texto: simples, ia: false, motivo: "sem registos", factos: [] });
  if (!env.AI) return resposta(cors, { texto: simples, ia: false, motivo: "IA não ligada no Cloudflare", factos: f.factos });
  const mensagens = [
    { role: "system", content: "És o assistente de operações dos armazéns da CARF, uma empresa de transportes. Escreves em português de Portugal (nunca do Brasil) o resumo de um dia para a passagem de turno entre supervisores. " +
      "Regras: usa APENAS os factos fornecidos; não inventes números, nomes, matrículas, horas nem causas; não acrescentes conselhos genéricos. " +
      "Formato: primeira linha exatamente igual ao título dado; depois uma linha 'Atenção:' com o que precisa de seguimento (se houver); depois tópicos curtos começados por '• '. " +
      "Máximo 170 palavras. Sem saudações, sem despedida, sem assinatura, sem markdown (nada de ** nem #)." },
    { role: "user", content: "Título: " + titulo + "\nPontos de atenção: " + (f.atencao.join(", ") || "nenhum") + "\nFactos do dia:\n" + f.factos.map(x => "- " + x).join("\n") }
  ];
  for (const modelo of MODELOS_IA) {
    try {
      const out = await env.AI.run(modelo, { messages: mensagens, max_tokens: 700, temperature: 0.2 });
      let t = String((out && (out.response || (out.result && out.result.response))) || "").replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim();
      if (t.length > 40) return resposta(cors, { texto: t.slice(0, 4000), ia: true, modelo, factos: f.factos });
    } catch (e) { /* sem quota ou modelo indisponível: tenta o seguinte */ }
  }
  return resposta(cors, { texto: simples, ia: false, motivo: "a IA não respondeu (limite diário gratuito ou serviço indisponível)", factos: f.factos });
}

async function gestaoLimpar(request, env, cors) {
  if (!env.ADMIN || !iguais(request.headers.get("X-Admin") || "", env.ADMIN)) {
    await pausa(600);
    return erro(cors, 403, "admin", "Código de administrador errado.");
  }
  let b; try { b = await request.json(); } catch (e) { return erro(cors, 400, "pedido", "Pedido inválido."); }
  const polo = b.polo === "*" ? "*" : String(b.polo || "");
  if (polo !== "*" && !idPolo(polo)) return erro(cors, 400, "polo", "Armazém inválido.");
  const apps = (Array.isArray(b.apps) ? b.apps : []).filter(a => APPS.has(a) && (polo === "*") === GLOBAIS.has(a));
  if (!apps.length) return erro(cors, 400, "apps", "Escolha o tipo de dados a apagar.");
  const dt = x => /^\d{4}-\d{2}-\d{2}$/.test(x || "") ? x : "";
  const de = dt(b.de), ate = dt(b.ate);
  const DIA = "(CASE WHEN dia GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN dia ELSE date(criado / 1000, 'unixepoch') END)";
  const cond = "polo = ? AND apagado = 0 AND app IN (" + apps.map(() => "?").join(",") + ")" + (de ? " AND " + DIA + " >= ?" : "") + (ate ? " AND " + DIA + " <= ?" : "");
  const args = [polo, ...apps, ...(de ? [de] : []), ...(ate ? [ate] : [])];
  if (b.simular) {
    const r = await env.DB.prepare("SELECT app, COUNT(*) AS n FROM registos WHERE " + cond + " GROUP BY app").bind(...args).all();
    const porApp = {}; let registos = 0;
    for (const x of r.results || []) { porApp[x.app] = x.n; registos += x.n; }
    let fotos = 0;
    if (polo !== "*" && registos) {
      const f = await env.DB.prepare("SELECT COUNT(*) AS n FROM fotos WHERE polo = ? AND registo IN (SELECT id FROM registos WHERE " + cond + ")").bind(polo, ...args).first();
      fotos = (f && f.n) || 0;
    }
    return resposta(cors, { ok: true, simulado: true, registos, fotos, porApp });
  }
  const t = Date.now();
  // fotografias dos registos que vão ser apagados
  let fotos = 0;
  if (polo !== "*") {
    const f = await env.DB.prepare("SELECT id FROM fotos WHERE polo = ? AND registo IN (SELECT id FROM registos WHERE " + cond + ")").bind(polo, ...args).all();
    const ids = (f.results || []).map(x => x.id);
    if (ids.length) {
      if (env.FOTOS) for (let i = 0; i < ids.length; i += 1000) await env.FOTOS.delete(ids.slice(i, i + 1000).map(x => chaveR2(polo, x)));
      await env.DB.prepare("DELETE FROM fotos WHERE polo = ? AND registo IN (SELECT id FROM registos WHERE " + cond + ")").bind(polo, ...args).run();
      fotos = ids.length;
    }
  }
  const r = await env.DB.prepare("UPDATE registos SET apagado = 1, alterado = ?, alterado_por = 'Limpeza' WHERE " + cond).bind(t, ...args).run();
  // regista a limpeza para os telemóveis esquecerem a cópia destas apps
  const ant = await env.DB.prepare("SELECT dados FROM limpezas_app WHERE polo = ?").bind(polo).first();
  let marcas = {}; try { marcas = ant ? JSON.parse(ant.dados) : {}; } catch (e) {}
  for (const a of apps) marcas[a] = { t, de, ate };
  await env.DB.prepare("INSERT INTO limpezas_app (polo, dados) VALUES (?, ?) ON CONFLICT (polo) DO UPDATE SET dados = excluded.dados").bind(polo, JSON.stringify(marcas)).run();
  return resposta(cors, { ok: true, registos: (r.meta && r.meta.changes) || 0, fotos });
}

// Opções e códigos de pneus acrescentados pelos supervisores (partilhados por todos os armazéns):
// GET lista tudo; POST {ids:[...]} apaga (para corrigir o que alguém pôs mal).
async function gestaoOpcoes(request, env, cors) {
  if (!env.ADMIN || !iguais(request.headers.get("X-Admin") || "", env.ADMIN)) {
    await pausa(600);
    return erro(cors, 403, "admin", "Código de administrador errado.");
  }
  if (request.method === "GET") {
    const r = await env.DB.prepare("SELECT id, dados, autor, criado FROM registos WHERE polo = '*' AND app = 'codigos' AND apagado = 0 ORDER BY criado DESC LIMIT 2000").all();
    return resposta(cors, { itens: (r.results || []).map(x => { let d = {}; try { d = JSON.parse(x.dados); } catch (e) {} return { id: x.id, dados: d, autor: x.autor, criado: x.criado }; }) });
  }
  let b; try { b = await request.json(); } catch (e) { return erro(cors, 400, "pedido", "Pedido inválido."); }
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => x && x.length <= 100).slice(0, 40);
  if (!ids.length) return resposta(cors, { ok: true, apagados: 0 });
  const t = Date.now();
  const r = await env.DB.prepare("UPDATE registos SET apagado = 1, alterado = ?, alterado_por = 'Gestão' WHERE polo = '*' AND app = 'codigos' AND apagado = 0 AND id IN (" + ids.map(() => "?").join(",") + ")")
    .bind(t, ...ids).run();
  return resposta(cors, { ok: true, apagados: (r.meta && r.meta.changes) || 0 });
}

async function gestao(request, url, env, cors) {
  if (!env.ADMIN || !iguais(request.headers.get("X-Admin") || "", env.ADMIN)) {
    await pausa(600);
    return erro(cors, 403, "admin", "Código de administrador errado.");
  }
  if (request.method === "GET") {
    const r = await env.DB.prepare("SELECT id, nome, config, ordem, ativo, alterado FROM polos ORDER BY ordem, nome").all();
    const f = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(tamanho), 0) AS bytes, COALESCE(SUM(length(dados)), 0) AS na_bd FROM fotos").first();
    return resposta(cors, { polos: (r.results || []).map(p => ({ ...p, config: configDe(p), ativo: !!p.ativo })),
      fotos: { n: (f && f.n) || 0, bytes: (f && f.bytes) || 0, naBaseDados: (f && f.na_bd) || 0, r2: !!env.FOTOS } });
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
      if (caminho === "/" && request.method === "GET") return resposta(cors, { ok: true, servico: "ops-carf-api", versao: VERSAO, fotos: env.FOTOS ? "r2" : "base de dados" });
      if (caminho === "/polos" && request.method === "GET") {
        const r = await env.DB.prepare("SELECT id, nome FROM polos WHERE ativo = 1 ORDER BY ordem, nome").all();
        return resposta(cors, { polos: r.results || [] });
      }
      if (caminho === "/entrar" && request.method === "POST") return await entrar(request, env, cors);
      if (caminho === "/gestao/polos" && (request.method === "GET" || request.method === "POST")) return await gestao(request, url, env, cors);
      if (caminho === "/gestao/opcoes" && (request.method === "GET" || request.method === "POST")) return await gestaoOpcoes(request, env, cors);
      if (caminho === "/gestao/limpar" && request.method === "POST") return await gestaoLimpar(request, env, cors);
      const s = await sessaoDe(request, env);
      if (!s) return erro(cors, 401, "sessao", "Sessão expirada ou código do armazém alterado. Entre de novo.");
      if (caminho === "/sessao" && request.method === "GET")
        return resposta(cors, { polo: { id: s.polo.id, nome: s.polo.nome }, nome: s.nome, config: configDe(s.polo) });
      if (caminho === "/registos" && request.method === "GET") return await listar(url, env, cors, s);
      if (caminho === "/registos" && request.method === "POST") return await gravar(request, env, cors, s);
      if (caminho === "/resumo" && request.method === "POST") return await resumoDia(request, env, cors, s);
      if (caminho === "/fotos" && request.method === "POST") return await enviarFoto(request, url, env, cors, s);
      if (caminho === "/fotos/apagar" && request.method === "POST") return await apagarFotos(request, env, cors, s);
      if (caminho.startsWith("/fotos/") && request.method === "GET") return await lerFoto(decodeURIComponent(caminho.slice(7)), env, cors, s);
      return erro(cors, 404, "caminho", "Caminho desconhecido.");
    } catch (e) {
      return erro(cors, 500, "interno", "Erro no servidor: " + (e && e.message || e));
    }
  },
};
