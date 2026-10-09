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
      for (const [id, r] of Object.entries(est.cache)) if (r.dia && r.dia < lim && !est.fila[id]) delete est.cache[id];
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
          for (let i = 0; i < ids.length; i += 100) {
            const lote = ids.slice(i, i + 100).map(id => est.fila[id]).filter(Boolean);
            if (!lote.length) continue;
            const j = await pedido("/registos", { metodo: "POST", corpo: { app, itens: lote }, token: s.token });
            for (const res of j.resultados || []) {
              const enviado = lote.find(x => x.id === res.id);
              const mudouEntretanto = est.fila[res.id] && est.fila[res.id] !== enviado;
              if (!mudouEntretanto) delete est.fila[res.id];
              if (mudouEntretanto) continue;
              if (res.registo) { if (res.registo.apagado) delete est.cache[res.id]; else est.cache[res.id] = res.registo; }
              else if (enviado && enviado.apagado) delete est.cache[res.id];
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
      (async function ciclo() {
        if (document.visibilityState === "visible" && navigator.onLine !== false) { try { await sincronizar(); } catch (e) {} }
        setTimeout(ciclo, ativo() && !estado.erro ? RAPIDO : LENTO);
      })();
    }
    return { app, sessao: s, registos, obter, gravar, apagar, podeApagar, sincronizar, pendentes, estado: () => ({ ...estado, pendentes: pendentes() }),
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
  function barra(lig, onde) {
    estilos();
    const el = document.createElement("div"); el.className = "sjt-barra"; el.setAttribute("role", "status");
    const esq = document.createElement("span"), dir = document.createElement("span");
    el.append(esq, dir); onde.insertAdjacentElement("afterend", el);
    const s = lig.sessao;
    function pintar() {
      const e = lig.estado();
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
    lig.ouvir(pintar); window.addEventListener("online", pintar); window.addEventListener("offline", pintar); pintar();
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
  const autorTxt = r => !r ? "" : (r.meu ? "Você" : r.autor || "?") + (r.alteradoPor ? " · alterado por " + r.alteradoPor : "");

  window.SJT = { api, pedido, dispositivo, sessao, entrar, sair, exigirSessao, atualizarSessao, lista, ligar, barra, oferecerMigracao, autorTxt, ler, escrever };
})();
