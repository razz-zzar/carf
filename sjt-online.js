/* OPS CARF — ligação online partilhada pelas apps do hub.
   - Sessão: armazém (polo), nome do supervisor e código de acesso, guardados neste telemóvel.
   - Cada app guarda uma cópia local dos registos do armazém e uma fila do que falta enviar:
     funciona sem rede e envia sozinha quando a rede volta.
   - Só quem criou um registo o pode apagar (a API confirma). */
(function () {
  "use strict";
  const API_PADRAO = "https://ops-carf-api.frplopes91.workers.dev";
  const api = () => { try { return localStorage.getItem("sjt_api_teste") || API_PADRAO; } catch (e) { return API_PADRAO; } };
  const ler = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const escrever = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const apagarChave = k => { try { localStorage.removeItem(k); } catch (e) {} };

  function dispositivo() {
    let d = ler("sjt_dispositivo", null);
    if (!d || String(d).length < 8) {
      d = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
      escrever("sjt_dispositivo", d);
    }
    return d;
  }
  const sessao = () => ler("sjt_sessao", null);

  class ErroAPI extends Error { constructor(m, estado, codigo) { super(m); this.estado = estado; this.codigo = codigo; } }
  async function pedido(caminho, { metodo = "GET", corpo, token, admin, tempo = 15000 } = {}) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), tempo);
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    if (admin) headers["X-Admin"] = admin;
    let r;
    try { r = await fetch(api() + caminho, { method: metodo, headers, signal: ctl.signal, cache: "no-store", body: corpo === undefined ? undefined : JSON.stringify(corpo) }); }
    catch (e) { throw new ErroAPI("Sem ligação à internet.", 0, "rede"); }
    finally { clearTimeout(t); }
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new ErroAPI(j.erro || "Erro " + r.status + " no servidor.", r.status, j.codigo || "");
    return j;
  }

  async function entrar(polo, codigo, nome) {
    const j = await pedido("/entrar", { metodo: "POST", corpo: { polo, codigo, nome, dispositivo: dispositivo() } });
    escrever("sjt_sessao", { token: j.token, polo: j.polo, nome: j.nome, config: j.config || {}, entrou: Date.now() });
    escrever("sjt_ultimo", { polo: j.polo.id, nome: j.nome });
    return sessao();
  }
  function sair() { apagarChave("sjt_sessao"); }
  function irParaEntrada(motivo) {
    const app = location.pathname.split("/").pop() || "";
    location.replace("./?entrar=" + encodeURIComponent(app) + (motivo ? "&motivo=" + encodeURIComponent(motivo) : ""));
  }
  /* Nas apps: sem sessão vai para o hub escolher o armazém */
  function exigirSessao() {
    const s = sessao();
    if (s && s.token) return s;
    irParaEntrada("");
    return { token: "", polo: { id: "", nome: "" }, nome: "", config: {} };
  }
  /* Atualiza o nome e as listas do armazém (quando há rede) */
  async function atualizarSessao() {
    const s = sessao(); if (!s || !s.token) return null;
    try {
      const j = await pedido("/sessao", { token: s.token, tempo: 8000 });
      const nova = { ...s, polo: j.polo, nome: j.nome, config: j.config || {} };
      escrever("sjt_sessao", nova); return nova;
    } catch (e) {
      if (e.estado === 401) { sair(); irParaEntrada("expirou"); }
      return null;
    }
  }
  /* Listas do polo, definidas na página de gestão.
     Os motivos das penalizações vêm dos dados base quando o polo não tem os seus. */
  function lista(nome, s) {
    s = s || sessao() || { polo: {}, config: {} };
    const c = s.config || {}, v = c[nome];
    const temValor = Array.isArray(v) ? v.length > 0 : (v && typeof v === "object" ? Object.keys(v).length > 0 : false);
    if (temValor) return v;
    const base = window.SJT_DADOS_BASE || {};
    if (nome === "motivos") return base.motivos || [];
    return nome === "matriz" ? {} : [];
  }

  /* ---------- ligação de uma app ---------- */
  function ligar(app, { aoMudar, diasLocais = 62 } = {}) {
    const s = sessao() || { token: "", polo: { id: "" }, nome: "" };
    const chave = "sjt_dados_" + s.polo.id + "_" + app;
    const est = ler(chave, null) || { cache: {}, fila: {}, cursor: 0 };
    est.cache = est.cache || {}; est.fila = est.fila || {}; est.cursor = est.cursor || 0;
    /* A cópia local guarda só os últimos dias (o servidor guarda tudo) */
    if (diasLocais) {
      const lim = new Date(Date.now() - diasLocais * 86400000).toISOString().slice(0, 10);
      for (const [id, r] of Object.entries(est.cache)) if (r.dia && r.dia < lim && !est.fila[id] && !(r.dados && r.dados.afixada)) delete est.cache[id]; /* as afixadas ficam sempre */
    }
    const estado = { rede: navigator.onLine !== false, erro: "", ultima: 0, aSincronizar: false };
    const ouvintes = new Set(); if (aoMudar) ouvintes.add(aoMudar);
    const avisar = info => ouvintes.forEach(f => { try { f(info || {}); } catch (e) { console.error(e); } });
    const guardar = () => escrever(chave, est);

    const registos = () => Object.values(est.cache).filter(r => !r.apagado);
    const obter = id => { const r = est.cache[id]; return r && !r.apagado ? r : null; };

    function gravar(id, dia, dados) {
      const ant = est.cache[id], vivo = ant && !ant.apagado, filaAnt = est.fila[id];
      const r = { id, dia: dia || "", dados, autor: vivo ? ant.autor : s.nome, alteradoPor: vivo && !ant.meu ? s.nome : (vivo ? ant.alteradoPor || "" : ""),
        meu: vivo ? ant.meu : true, criado: vivo ? ant.criado : Date.now(), alterado: Date.now(), apagado: false, pendente: true };
      est.cache[id] = r;
      est.fila[id] = { id, dia: r.dia, dados, criado: r.criado };
      if (!guardar()) { if (ant) est.cache[id] = ant; else delete est.cache[id]; if (filaAnt) est.fila[id] = filaAnt; else delete est.fila[id]; return false; }
      avisar({ local: true }); agendar(); return true;
    }
    /* Altera só alguns campos de um registo (ex. { "vistos.ana": {...} } ou { afixada: true }; null apaga o campo).
       O servidor junta a alteração ao registo que já tem, por isso duas pessoas a mexer ao mesmo tempo não se apagam. */
    function aplicar(d, campos) {
      for (const [k, v] of Object.entries(campos)) {
        const p = k.split("."); let o = d;
        for (let i = 0; i < p.length - 1; i++) { if (!o[p[i]] || typeof o[p[i]] !== "object") o[p[i]] = {}; o = o[p[i]]; }
        if (v === null) delete o[p[p.length - 1]]; else o[p[p.length - 1]] = v;
      }
    }
    function mudar(id, campos) {
      const r = est.cache[id];
      if (!r || r.apagado) return false;
      const antR = JSON.parse(JSON.stringify(r)), f = est.fila[id];
      if (f && f.apagado) return false;
      r.dados = JSON.parse(JSON.stringify(r.dados || {})); aplicar(r.dados, campos); r.pendente = true;
      /* objeto novo na fila: o que já está a ser enviado não se confunde com esta alteração */
      if (f && f.dados) est.fila[id] = { ...f, dados: JSON.parse(JSON.stringify(r.dados)) };
      else est.fila[id] = { id, campos: { ...(f && f.campos || {}), ...campos } };
      if (!guardar()) { est.cache[id] = antR; if (f) est.fila[id] = f; else delete est.fila[id]; return false; }
      avisar({ local: true }); agendar(); return true;
    }
    const podeApagar = r => !!(r && r.meu);
    function apagar(id) {
      const r = est.cache[id];
      if (!r || r.apagado) return true;
      if (!r.meu) return false;
      r.apagado = true; r.pendente = true; est.fila[id] = { id, apagado: true };
      guardar(); avisar({ local: true }); agendar(); return true;
    }

    let ocupado = null, temporizador = null;
    function agendar(ms) { clearTimeout(temporizador); temporizador = setTimeout(sincronizar, ms == null ? 250 : ms); }
    function sincronizar() {
      if (ocupado) return ocupado;
      if (!s.token) return Promise.resolve();
      estado.aSincronizar = true; avisar({ estado: true });
      ocupado = (async () => {
        const avisos = [];
        try {
          /* 1) enviar o que está na fila */
          const ids = Object.keys(est.fila);
          for (let i = 0; i < ids.length; i += 20) { /* a API aceita 20 de cada vez (limite do plano gratuito) */
            const lote = ids.slice(i, i + 20).map(id => est.fila[id]).filter(Boolean);
            if (!lote.length) continue;
            const j = await pedido("/registos", { metodo: "POST", corpo: { app, itens: lote }, token: s.token });
            for (const res of j.resultados || []) {
              const enviado = lote.find(x => x.id === res.id);
              const mudouEntretanto = est.fila[res.id] && est.fila[res.id] !== enviado;
              if (!mudouEntretanto) delete est.fila[res.id];
              if (mudouEntretanto) continue;
              if (res.registo) { if (res.registo.apagado) delete est.cache[res.id]; else est.cache[res.id] = res.registo; }
              else if (enviado && enviado.apagado) delete est.cache[res.id];
              if (res.codigo === "nao_existe") { delete est.cache[res.id]; continue; } /* foi apagado entretanto por quem o fez */
              if (!res.ok) avisos.push(res.codigo === "so_autor" ? "Só quem fez o registo o pode apagar." : "Um registo não foi aceite pelo servidor.");
            }
            guardar();
          }
          /* 2) receber o que os outros registaram */
          let mais = true, voltas = 0;
          while (mais && voltas++ < 50) {
            const antes = est.cursor;
            const j = await pedido("/registos?app=" + encodeURIComponent(app) + "&desde=" + est.cursor, { token: s.token });
            if ((j.registos || []).length) ultimaNovidade = Date.now();
            for (const r of j.registos || []) {
              if (!est.fila[r.id]) { if (r.apagado) delete est.cache[r.id]; else est.cache[r.id] = r; }
              if (r.alterado > est.cursor) est.cursor = r.alterado;
            }
            mais = !!j.mais && est.cursor > antes;
          }
          guardar();
          estado.rede = true; estado.erro = ""; estado.ultima = Date.now();
        } catch (e) {
          if (e.estado === 401) { sair(); irParaEntrada("expirou"); return; }
          estado.rede = e.codigo !== "rede"; estado.erro = e.message;
        } finally {
          estado.aSincronizar = false;
        }
        avisar({ remoto: true, avisos });
      })().finally(() => { ocupado = null; });
      return ocupado;
    }
    const pendentes = () => Object.keys(est.fila).length;

    /* Atualiza sozinho: ao abrir, ao voltar à app, quando a rede volta e com um ritmo que se adapta:
       - de 3 em 3 s enquanto alguém mexe na app (últimos 3 min) ou chegam registos novos (últimos 2 min);
       - de 15 em 15 s quando a app está aberta mas parada;
       - nada com a app em segundo plano (atualiza logo ao voltar).
       Assim quem está a trabalhar vê as alterações dos outros em poucos segundos, sem gastar
       os pedidos diários do plano gratuito da Cloudflare com telemóveis parados. */
    let ultimoToque = Date.now(), ultimaNovidade = 0;
    const RAPIDO = 3000, LENTO = 15000;
    const ativo = () => Date.now() - ultimoToque < 180000 || Date.now() - ultimaNovidade < 120000;
    if (s.token) {
      const toque = () => { const estavaParado = !ativo(); ultimoToque = Date.now(); if (estavaParado) agendar(0); };
      ["pointerdown", "keydown", "touchstart"].forEach(ev => window.addEventListener(ev, toque, { passive: true, capture: true }));
      window.addEventListener("online", () => agendar(0));
      window.addEventListener("offline", () => { estado.rede = false; avisar({ estado: true }); });
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { ultimoToque = Date.now(); agendar(0); } });
      /* arranca depois de a app acabar de se preparar (a app ainda não tem a ligação quando ligar() corre) */
      const ciclo = async () => {
        if (document.visibilityState === "visible" && navigator.onLine !== false) { try { await sincronizar(); } catch (e) {} }
        setTimeout(ciclo, ativo() && !estado.erro ? RAPIDO : LENTO);
      };
      setTimeout(ciclo, 0);
    }
    return { app, sessao: s, registos, obter, gravar, mudar, apagar, podeApagar, sincronizar, pendentes, estado: () => ({ ...estado, pendentes: pendentes() }),
             ouvir: f => ouvintes.add(f), primeiraVez: () => est.cursor === 0 };
  }

  /* ---------- pequenos elementos de interface comuns ---------- */
  function estilos() {
    if (document.getElementById("sjt-estilos")) return;
    const st = document.createElement("style"); st.id = "sjt-estilos";
    st.textContent = `.sjt-barra{display:flex;align-items:center;justify-content:space-between;gap:10px;font:500 13px system-ui,sans-serif;color:var(--muted,#93a39a);padding:8px 2px 0;flex-wrap:wrap}
.sjt-barra b{color:var(--fg,#eef3ef);font-weight:600}
.sjt-ponto{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--green,#B9D406);margin-right:6px;vertical-align:1px}
.sjt-barra.off .sjt-ponto{background:#e0a84f}.sjt-barra.err .sjt-ponto{background:var(--danger,#e0574f)}
.sjt-barra a{color:var(--green,#B9D406);text-decoration:none;font-weight:600}
.sjt-aviso{border:1px solid var(--green,#B9D406);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:14px;color:var(--fg,#eef3ef)}
.sjt-aviso div{display:flex;gap:8px;flex-wrap:wrap}
.sjt-aviso button{flex:1;min-height:42px;border-radius:8px;font:700 15px system-ui,sans-serif;cursor:pointer;border:2px solid var(--green,#B9D406);background:transparent;color:var(--green,#B9D406)}
.sjt-aviso button.p{background:var(--green,#B9D406);color:#0a0a0a}
.sjt-autor{color:var(--muted,#93a39a);font-size:12px}`;
    document.head.appendChild(st);
  }
  /* Linha com o armazém, o nome e o estado da ligação */
  function barra(lig, onde, extra) {
    estilos();
    const el = document.createElement("div"); el.className = "sjt-barra"; el.setAttribute("role", "status");
    const esq = document.createElement("span"), dir = document.createElement("span");
    el.append(esq, dir); onde.insertAdjacentElement("afterend", el);
    const s = lig.sessao;
    function pintar() {
      const e = lig.estado();
      const fx = extra && extra.pendentes ? extra.pendentes() : 0;
      if (fx) e.pendentes = (e.pendentes || 0) + fx;
      esq.textContent = ""; const b = document.createElement("b"); b.textContent = s.polo.nome; esq.append(b, " · " + s.nome);
      let txt, cls = "";
      if (e.rede === false || (!navigator.onLine)) { cls = "off"; txt = "Sem rede" + (e.pendentes ? " · " + e.pendentes + " por enviar" : " · a mostrar o que está no telemóvel"); }
      else if (e.erro) { cls = "err"; txt = "Erro: " + e.erro; }
      else if (e.pendentes) txt = "A enviar " + e.pendentes + "…";
      else if (e.aSincronizar && !e.ultima) txt = "A carregar…";
      else txt = "Online";
      el.className = "sjt-barra" + (cls ? " " + cls : "");
      dir.textContent = ""; const p = document.createElement("span"); p.className = "sjt-ponto"; dir.append(p, txt);
    }
    lig.ouvir(pintar); window.addEventListener("online", pintar); window.addEventListener("offline", pintar);
    if (extra && extra.ouvir) extra.ouvir(pintar);
    pintar();
    return el;
  }
  /* Registos que já estavam neste telemóvel antes do online: o supervisor decide se os envia */
  function oferecerMigracao(app, n, enviar, onde) {
    const flag = "sjt_migrado_" + app;
    if (!n || ler(flag, false)) return;
    estilos();
    const el = document.createElement("div"); el.className = "sjt-aviso";
    const p = document.createElement("span");
    p.textContent = "Este telemóvel tem " + n + " registo" + (n === 1 ? "" : "s") + " de antes de a app estar online. Quer enviá-" + (n === 1 ? "lo" : "los") + " para o armazém, para os outros verem?";
    const bs = document.createElement("div");
    const sim = document.createElement("button"); sim.className = "p"; sim.type = "button"; sim.textContent = "Enviar";
    const nao = document.createElement("button"); nao.type = "button"; nao.textContent = "Não enviar";
    sim.onclick = () => { enviar(); escrever(flag, true); el.remove(); };
    nao.onclick = () => { escrever(flag, true); el.remove(); };
    bs.append(sim, nao); el.append(p, bs);
    onde.insertAdjacentElement("afterbegin", el);
  }
  /* ---------- fotografias ----------
     Reduzidas no telemóvel (máx. 1280 px, JPEG) e guardadas no próprio telemóvel (IndexedDB)
     até serem enviadas; sem rede ficam em espera. As dos colegas descarregam-se quando se abrem. */
  function fotos() {
    if (fotos._m) return fotos._m;
    const s = sessao() || { token: "", polo: { id: "" } };
    const ouvintes = new Set(), urls = new Map();
    let pend = 0, ocupado = null;
    const avisar = () => ouvintes.forEach(f => { try { f(); } catch (e) {} });
    let dbP = null;
    function db() {
      if (dbP) return dbP;
      dbP = new Promise((ok, nok) => {
        let r; try { r = indexedDB.open("sjt_fotos", 1); } catch (e) { nok(e); return; }
        r.onupgradeneeded = () => { const os = r.result.createObjectStore("fotos", { keyPath: "id" }); os.createIndex("polo", "polo"); };
        r.onsuccess = () => ok(r.result); r.onerror = () => nok(r.error);
      });
      return dbP;
    }
    const tx = async (modo, fn) => { const d = await db(); return new Promise((ok, nok) => {
      const t = d.transaction("fotos", modo), os = t.objectStore("fotos"); let res; const r = fn(os);
      if (r) r.onsuccess = () => { res = r.result; }; t.oncomplete = () => ok(res); t.onerror = () => nok(t.error); t.onabort = () => nok(t.error); }); };
    const obterLocal = id => tx("readonly", os => os.get(id));
    const gravarLocal = f => tx("readwrite", os => os.put(f));
    const apagarLocal = id => tx("readwrite", os => os.delete(id));
    const todasDoPolo = () => tx("readonly", os => os.index("polo").getAll(s.polo.id));

    async function reduzir(ficheiro, lado = 1280, qualidade = 0.72) {
      let img;
      try { img = await createImageBitmap(ficheiro, { imageOrientation: "from-image" }); }
      catch (e) {
        img = await new Promise((ok, nok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => nok(new Error("Não foi possível ler a fotografia.")); i.src = URL.createObjectURL(ficheiro); });
      }
      const w = img.width, h = img.height, k = Math.min(1, lado / Math.max(w, h));
      const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      if (img.close) img.close();
      return await new Promise((ok, nok) => c.toBlob(b => b ? ok(b) : nok(new Error("Não foi possível preparar a fotografia.")), "image/jpeg", qualidade));
    }
    async function contar() {
      try { pend = (await todasDoPolo()).filter(f => !f.enviada).length; } catch (e) { pend = 0; }
      avisar(); return pend;
    }
    /* Guarda uma fotografia nova (já reduzida) associada a um registo; devolve o id */
    async function guardar(registo, blob) {
      const id = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + dispositivo().replace(/[^a-z0-9]/gi, "").slice(0, 6);
      await gravarLocal({ id, polo: s.polo.id, registo, blob, enviada: false, criado: Date.now() });
      urls.set(id, URL.createObjectURL(blob));
      await contar(); agendar(); return id;
    }
    async function enviar() {
      if (ocupado) return ocupado;
      if (!s.token || navigator.onLine === false) return;
      ocupado = (async () => {
        try {
          const lista = (await todasDoPolo()).filter(f => !f.enviada).sort((a, b) => a.criado - b.criado);
          for (const f of lista) {
            const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
            let r;
            try { r = await fetch(api() + "/fotos?id=" + encodeURIComponent(f.id) + "&registo=" + encodeURIComponent(f.registo || ""),
              { method: "POST", headers: { Authorization: "Bearer " + s.token, "Content-Type": f.blob.type || "image/jpeg" }, body: f.blob, signal: ctl.signal }); }
            catch (e) { break; } finally { clearTimeout(t); }
            if (r.status === 401) { sair(); irParaEntrada("expirou"); return; }
            if (r.ok || r.status === 413 || r.status === 400) { f.enviada = true; f.recusada = !r.ok; await gravarLocal(f); }
            else break;
            await contar();
          }
          /* apagadas sem rede: apagar agora no servidor */
          const fila = ler("sjt_fotos_apagar_" + s.polo.id, []);
          if (fila.length) {
            try { await pedido("/fotos/apagar", { metodo: "POST", corpo: { ids: fila.slice(0, 40) }, token: s.token });
              escrever("sjt_fotos_apagar_" + s.polo.id, fila.slice(40)); } catch (e) {}
          }
          /* limpar fotografias já enviadas com mais de 62 dias */
          const lim = Date.now() - 62 * 86400000;
          for (const f of await todasDoPolo()) if (f.enviada && f.criado < lim) await apagarLocal(f.id);
        } catch (e) {}
        await contar();
      })().finally(() => { ocupado = null; });
      return ocupado;
    }
    let temp = null;
    function agendar(ms) { clearTimeout(temp); temp = setTimeout(enviar, ms == null ? 300 : ms); }
    /* Endereço para mostrar a fotografia (do telemóvel ou descarregada) */
    async function url(id) {
      if (urls.has(id)) return urls.get(id);
      let f = null; try { f = await obterLocal(id); } catch (e) {}
      if (!f) {
        const r = await fetch(api() + "/fotos/" + encodeURIComponent(id), { headers: { Authorization: "Bearer " + s.token } });
        if (!r.ok) throw new Error(r.status === 404 ? "Fotografia ainda não enviada por quem a tirou." : "Não foi possível carregar a fotografia.");
        const blob = await r.blob();
        f = { id, polo: s.polo.id, registo: "", blob, enviada: true, criado: Date.now() };
        try { await gravarLocal(f); } catch (e) {}
      }
      const u = URL.createObjectURL(f.blob); urls.set(id, u); return u;
    }
    async function blob(id) { await url(id); const f = await obterLocal(id).catch(() => null); if (f) return f.blob;
      const r = await fetch(urls.get(id)); return r.blob(); }
    async function estado(id) { const f = await obterLocal(id).catch(() => null); return f ? (f.enviada ? "enviada" : "por enviar") : "no servidor"; }
    async function apagar(ids) {
      for (const id of ids) {
        let f = null; try { f = await obterLocal(id); } catch (e) {}
        try { await apagarLocal(id); } catch (e) {}
        if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
        if (!f || f.enviada) { const k = "sjt_fotos_apagar_" + s.polo.id; const l = ler(k, []); if (!l.includes(id)) { l.push(id); escrever(k, l); } }
      }
      await contar(); agendar();
    }
    if (s.token) {
      window.addEventListener("online", () => agendar(0));
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") agendar(0); });
      setInterval(() => { if (pend || ler("sjt_fotos_apagar_" + s.polo.id, []).length) enviar(); }, 20000);
      contar().then(() => agendar(0));
    }
    fotos._m = { reduzir, guardar, enviar, url, blob, estado, apagar, pendentes: () => pend, ouvir: f => ouvintes.add(f) };
    return fotos._m;
  }

  const autorTxt = r => !r ? "" : (r.meu ? "Você" : r.autor || "?") + (r.alteradoPor ? " · alterado por " + r.alteradoPor : "");

  window.SJT = { api, pedido, dispositivo, sessao, entrar, sair, exigirSessao, atualizarSessao, lista, ligar, barra, oferecerMigracao, autorTxt, ler, escrever, fotos };
})();
