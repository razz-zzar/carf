/* OPS CARF — leitor de códigos (QR / código de barras) com a câmara, partilhado pelas apps.
   Uso: const txt = await SJT_LEITOR.abrir({ titulo: "Ler guia", texto: "Aponte para…", preferir: "barras" });
   Devolve o texto lido, o que foi escrito à mão, ou null se fechar.
   Guia: SJT_LEITOR.numeroGuia(txt) → { num, origem, curto, todos } (primeiros 19 algarismos). */
(function () {
  "use strict";
  const LIB = "https://cdn.jsdelivr.net/npm/barcode-detector@2.3.1/pure/+esm";
  const FORMATOS = ["qr_code", "ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "itf", "data_matrix"];
  const GUIA_ALGARISMOS = 19;
  let detetor = null, ui = null;

  /* ---- Focar ao tocar no ecrã (partilhado com a câmara das etiquetas, em pneus.html) ----
     Android/Chrome: foca no ponto tocado (pointsOfInterest) ou, se a câmara não deixar escolher o ponto,
     obriga-a a refocar. iPhone/Safari não deixa controlar a focagem: mostra o anel e a câmara foca sozinha. */
  const FOCO_CSS = `.carf-foco{position:absolute;width:74px;height:74px;margin:-37px 0 0 -37px;border:2px solid #fff;border-radius:50%;pointer-events:none;box-shadow:0 0 0 1px rgba(0,0,0,.4);animation:carfFoco .9s ease-out forwards}
@keyframes carfFoco{0%{transform:scale(1.5);opacity:0}25%{transform:scale(1);opacity:1}75%{opacity:1}100%{transform:scale(.9);opacity:0}}
.carf-dica{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);background:rgba(0,0,0,.55);color:#fff;font:600 13px system-ui,sans-serif;padding:6px 12px;border-radius:999px;pointer-events:none;white-space:nowrap}`;
  function estiloFoco() {
    if (document.getElementById("carf-foco-css")) return;
    const st = document.createElement("style"); st.id = "carf-foco-css"; st.textContent = FOCO_CSS; document.head.appendChild(st);
  }
  function focarAoTocar(caixa, video, obterTrack) {
    estiloFoco();
    if (!caixa.querySelector(".carf-dica")) { const d = document.createElement("div"); d.className = "carf-dica"; d.textContent = "Toque para focar"; caixa.appendChild(d); }
    if (caixa.dataset.foco) return; caixa.dataset.foco = "1";
    let volta = null;
    caixa.addEventListener("pointerdown", async e => {
      const r = caixa.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      caixa.querySelectorAll(".carf-foco").forEach(x => x.remove());
      const anel = document.createElement("div"); anel.className = "carf-foco"; anel.style.left = px + "px"; anel.style.top = py + "px";
      caixa.appendChild(anel); setTimeout(() => anel.remove(), 1000);
      const tr = obterTrack(); if (!tr || !tr.getCapabilities) return;
      let cap = {}; try { cap = tr.getCapabilities(); } catch (err) { return; }
      /* ponto tocado em coordenadas do vídeo (o vídeo está em object-fit:cover, pode estar cortado) */
      const vw = video.videoWidth || r.width, vh = video.videoHeight || r.height, esc = Math.max(r.width / vw, r.height / vh);
      const ox = (r.width - vw * esc) / 2, oy = (r.height - vh * esc) / 2;
      const ponto = { x: Math.min(1, Math.max(0, (px - ox) / (vw * esc))), y: Math.min(1, Math.max(0, (py - oy) / (vh * esc))) };
      const modos = cap.focusMode || [], temPonto = "pointsOfInterest" in cap;
      const aplicar = c => tr.applyConstraints({ advanced: [c] }).catch(() => {});
      clearTimeout(volta);
      if (modos.includes("single-shot")) {
        await aplicar(temPonto ? { pointsOfInterest: [ponto], focusMode: "single-shot" } : { focusMode: "single-shot" });
        if (modos.includes("continuous")) volta = setTimeout(() => aplicar(temPonto ? { pointsOfInterest: [ponto], focusMode: "continuous" } : { focusMode: "continuous" }), 3000);
      } else if (modos.includes("continuous")) {
        if (modos.includes("manual")) await aplicar({ focusMode: "manual" });   /* larga a focagem para a câmara refocar */
        await aplicar(temPonto ? { pointsOfInterest: [ponto], focusMode: "continuous" } : { focusMode: "continuous" });
      } else if (temPonto) await aplicar({ pointsOfInterest: [ponto] });
    });
  }

  function estilos() {
    if (document.getElementById("sjt-leitor-css")) return;
    const st = document.createElement("style"); st.id = "sjt-leitor-css";
    st.textContent = `.sjtl{--sv:var(--green,#B9D406);position:fixed;inset:0;z-index:60;background:#000;display:flex;flex-direction:column;gap:10px;padding:calc(12px + env(safe-area-inset-top,0px)) 16px calc(16px + env(safe-area-inset-bottom,0px));color:#eef3ef;font-family:var(--body,system-ui,sans-serif)}
.sjtl[hidden]{display:none!important}
.sjtl-top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.sjtl-top b{font:700 21px var(--body,system-ui,sans-serif);color:var(--sv)}
.sjtl button{cursor:pointer;font-family:inherit}
.sjtl-x{background:none;border:1px solid #3a4440;color:#eef3ef;border-radius:8px;padding:10px 14px;font-weight:600;font-size:15px}
.sjtl-vid{position:relative;flex:1;min-height:0;border-radius:12px;overflow:hidden;background:#111;touch-action:manipulation}
.sjtl-vid video{width:100%;height:100%;object-fit:cover;display:block}
.sjtl-mira{position:absolute;inset:32% 7%;border:3px solid var(--sv);border-radius:14px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none}
.sjtl-mira.qr{inset:auto;left:50%;top:44%;width:66%;aspect-ratio:1/1;transform:translate(-50%,-50%)}
.sjtl-zoom{position:absolute;left:50%;bottom:48px;transform:translateX(-50%);display:flex;gap:6px}
.sjtl-zoom button{min-width:46px;height:40px;border-radius:999px;border:0;background:rgba(0,0,0,.55);color:#fff;font-weight:700;font-size:14px}
.sjtl-zoom button[aria-pressed=true]{background:var(--sv);color:#111}
.sjtl-est{margin:0;min-height:40px;font-size:15px;text-align:center}
.sjtl-est.err{color:#e0574f}
.sjtl-bts{display:flex;gap:8px}
.sjtl-bts button{flex:1;border-radius:10px;padding:12px;font-weight:700;font-size:16px;background:transparent;color:var(--sv);border:2px solid var(--sv)}
.sjtl-bts button[hidden]{display:none}
.sjtl-man{display:grid;grid-template-columns:1fr auto;gap:8px}
.sjtl-man input{min-width:0;background:#0c0f0d;color:#eef3ef;border:1px solid #3a4440;border-radius:8px;padding:12px;font:500 17px var(--mono,ui-monospace,monospace)}
.sjtl-man button{border:0;border-radius:10px;padding:12px 18px;font-weight:700;font-size:17px;background:var(--sv);color:#111}`;
    document.head.appendChild(st);
  }
  function criarUI() {
    if (ui) return ui;
    estilos();
    const el = document.createElement("div"); el.className = "sjtl"; el.hidden = true;
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
    el.innerHTML = '<div class="sjtl-top"><b></b><button type="button" class="sjtl-x">Fechar</button></div>' +
      '<div class="sjtl-vid"><video playsinline muted></video><div class="sjtl-mira"></div><div class="sjtl-zoom" role="group" aria-label="Zoom"></div></div>' +
      '<p class="sjtl-est" role="status"></p>' +
      '<div class="sjtl-bts"><button type="button" class="sjtl-luz" hidden>Ligar lanterna</button><button type="button" class="sjtl-cam" hidden>Trocar câmara</button></div>' +
      '<form class="sjtl-man"><input type="text" autocomplete="off" aria-label="Escrever o código"><button type="submit">OK</button></form>';
    document.body.appendChild(el);
    ui = { el, tit: el.querySelector("b"), x: el.querySelector(".sjtl-x"), video: el.querySelector("video"), est: el.querySelector(".sjtl-est"),
           luz: el.querySelector(".sjtl-luz"), cam: el.querySelector(".sjtl-cam"), zoom: el.querySelector(".sjtl-zoom"),
           mira: el.querySelector(".sjtl-mira"), vid: el.querySelector(".sjtl-vid"), form: el.querySelector("form"), input: el.querySelector("input") };
    return ui;
  }
  async function obterDetetor(estado) {
    if (detetor) return detetor;
    const BD = window.BarcodeDetector;
    if (BD) {
      try { const sup = await BD.getSupportedFormats(); const f = FORMATOS.filter(x => sup.includes(x)); if (f.includes("qr_code")) { detetor = new BD({ formats: f }); return detetor; } } catch (e) {}
    }
    estado("A preparar o leitor (só da primeira vez)…");
    const mod = await import(LIB); detetor = new mod.BarcodeDetector({ formats: FORMATOS }); return detetor;
  }

  /* Câmaras traseiras (depois de haver autorização os nomes ficam visíveis) */
  const CHAVE_CAM = "carf_camara";
  async function camarasTraseiras() {
    try {
      const l = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
      const tras = l.filter(d => !/front|frontal|frente|user|facetime/i.test(d.label));
      return tras.length ? tras : l;
    } catch (e) { return []; }
  }
  async function abrirCamara(deviceId) {
    const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const v = deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: "environment" } };
    return navigator.mediaDevices.getUserMedia({ video: v, audio: false });
  }

  /* Recorte da zona da mira, ampliado: um QR pequeno ocupa poucos píxeis na imagem inteira
     (é o que a câmara do telemóvel faz melhor: analisa a imagem em resolução total). */
  const tela = document.createElement("canvas");
  function recorte(video, caixa, mira) {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
    const r = caixa.getBoundingClientRect(), m = mira.getBoundingClientRect();
    const esc = Math.max(r.width / vw, r.height / vh), ox = (r.width - vw * esc) / 2, oy = (r.height - vh * esc) / 2;
    const folga = 0.18 * Math.max(m.width, m.height);
    let x = (m.left - r.left - folga - ox) / esc, y = (m.top - r.top - folga - oy) / esc;
    let w = (m.width + 2 * folga) / esc, h = (m.height + 2 * folga) / esc;
    x = Math.max(0, x); y = Math.max(0, y); w = Math.min(vw - x, w); h = Math.min(vh - y, h);
    if (w < 40 || h < 40) return null;
    const k = Math.min(3, Math.max(1, 1000 / Math.max(w, h)));
    tela.width = Math.round(w * k); tela.height = Math.round(h * k);
    const cx = tela.getContext("2d", { willReadFrequently: true }); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(video, x, y, w, h, 0, 0, tela.width, tela.height);
    return tela;
  }

  function abrir({ titulo = "Ler código", texto = "Aponte para o código.", preferir = "qr" } = {}) {
    const u = criarUI();
    let stream = null, aLer = false, luz = false, fechado = false, sessao = 0;
    const estado = (t, err) => { u.est.textContent = t; u.est.className = "sjtl-est" + (err ? " err" : ""); };
    const track = () => stream && stream.getVideoTracks()[0];
    return new Promise(resolver => {
      function parar() { aLer = false; sessao++; if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } u.video.srcObject = null; }
      function fechar(valor) {
        if (fechado) return; fechado = true; parar();
        u.el.hidden = true; document.body.style.overflow = "";
        u.x.onclick = u.luz.onclick = u.cam.onclick = u.form.onsubmit = null;
        document.removeEventListener("keydown", tecla); document.removeEventListener("visibilitychange", vis);
        resolver(valor);
      }
      const tecla = e => { if (e.key === "Escape") fechar(null); };
      const vis = () => { if (document.hidden) fechar(null); };
      u.mira.classList.toggle("qr", preferir === "qr");
      u.tit.textContent = titulo; u.input.value = ""; u.input.placeholder = "Ou escreva o código";
      u.luz.hidden = true; u.cam.hidden = true; u.zoom.textContent = ""; u.luz.textContent = "Ligar lanterna";
      u.el.hidden = false; document.body.style.overflow = "hidden";
      u.x.onclick = () => fechar(null);
      u.form.onsubmit = e => { e.preventDefault(); const v = u.input.value.trim(); if (!v) { u.input.focus(); return; } fechar(v); };
      u.luz.onclick = async () => { try { const tr = track(); if (!tr) return; luz = !luz; await tr.applyConstraints({ advanced: [{ torch: luz }] }); u.luz.textContent = luz ? "Desligar lanterna" : "Ligar lanterna"; } catch (e) { u.luz.hidden = true; } };
      document.addEventListener("keydown", tecla); document.addEventListener("visibilitychange", vis);
      focarAoTocar(u.vid, u.video, track);

      function prepararTrack() {
        const tr = track(); if (!tr) return;
        let cap = {}; try { cap = tr.getCapabilities ? tr.getCapabilities() : {}; } catch (e) {}
        u.luz.hidden = !cap.torch; luz = false; u.luz.textContent = "Ligar lanterna";
        if (cap.focusMode && cap.focusMode.includes("continuous")) tr.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
        /* zoom: deixa afastar o telemóvel (a câmara foca melhor) e o código fica maior na imagem */
        u.zoom.textContent = "";
        if (cap.zoom && cap.zoom.max >= 1.5) {
          const min = Math.max(1, cap.zoom.min || 1), niveis = [1, 1.5, 2, 3].filter(z => z >= min && z <= cap.zoom.max);
          const por = z => { u.zoom.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.z === z))); tr.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {}); };
          niveis.forEach(z => { const b = document.createElement("button"); b.type = "button"; b.dataset.z = z; b.textContent = z + "×"; b.onclick = ev => { ev.stopPropagation(); por(z); }; b.addEventListener("pointerdown", ev => ev.stopPropagation()); u.zoom.appendChild(b); });
          por(preferir === "qr" && niveis.includes(1.5) ? 1.5 : niveis[0]);
        }
      }
      async function ligar(deviceId) {
        parar(); const minha = ++sessao;
        let novo;
        try { novo = await abrirCamara(deviceId); }
        catch (e) {
          if (deviceId) { try { localStorage.removeItem(CHAVE_CAM); } catch (x) {} return ligar(null); }
          estado(e && e.name === "NotAllowedError" ? "Sem autorização para usar a câmara. Autorize nas definições do navegador, ou escreva o código em baixo." : "Não foi possível abrir a câmara. Escreva o código em baixo.", true); return false;
        }
        if (fechado || minha !== sessao) { novo.getTracks().forEach(t => t.stop()); return false; }
        stream = novo;
        u.video.srcObject = stream; try { await u.video.play(); } catch (e) {}
        prepararTrack(); return true;
      }

      (async () => {
        estado("A abrir a câmara…");
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { estado("Este navegador não dá acesso à câmara. Escreva o código em baixo.", true); return; }
        let guardada = null; try { guardada = localStorage.getItem(CHAVE_CAM); } catch (e) {}
        if (!(await ligar(guardada))) return;
        /* vários telemóveis Android têm 2–4 câmaras traseiras e o navegador às vezes escolhe uma que não foca ao perto */
        const cams = await camarasTraseiras();
        if (cams.length > 1 && !fechado) {
          u.cam.hidden = false;
          u.cam.onclick = async () => {
            const atual = (track() && track().getSettings && track().getSettings().deviceId) || "";
            const i = cams.findIndex(c => c.deviceId === atual), prox = cams[(i + 1) % cams.length];
            try { localStorage.setItem(CHAVE_CAM, prox.deviceId); } catch (e) {}
            estado("A trocar de câmara…");
            if (await ligar(prox.deviceId)) { estado("Câmara " + ((cams.indexOf(prox)) + 1) + " de " + cams.length + ". " + texto); aLer = true; ciclo(); }
          };
        }
        try { await obterDetetor(estado); } catch (e) { estado("Não foi possível carregar o leitor (precisa de internet da primeira vez). Escreva o código em baixo.", true); return; }
        if (fechado) return;
        estado(texto); aLer = true; ciclo();
      })();

      async function ciclo() {
        const minha = sessao, inicio = Date.now(); let n = 0, ajudou = false;
        while (aLer && !fechado && minha === sessao) {
          if (u.video.readyState >= 2) {
            /* alterna: zona da mira ampliada (QR pequenos) e imagem inteira (códigos grandes ou fora da mira) */
            const fonte = (n++ % 2 === 0) ? (recorte(u.video, u.vid, u.mira) || u.video) : u.video;
            try {
              const r = await detetor.detect(fonte);
              if (r && r.length && !fechado && minha === sessao) {
                const qr = r.find(x => x.format === "qr_code"), barras = r.find(x => x.format !== "qr_code");
                const esc = preferir === "barras" ? (barras || qr) : (qr || barras);
                if (navigator.vibrate) navigator.vibrate(80);
                fechar(esc.rawValue); return;
              }
            } catch (e) {}
            if (!ajudou && Date.now() - inicio > 7000) { ajudou = true;
              estado("Não está a ler? Afaste um pouco o telemóvel" + (u.zoom.childElementCount ? " e use o zoom" : "") + ", toque no código para focar" + (u.cam.hidden ? "" : " ou troque de câmara") + "."); }
          }
          await new Promise(ok => setTimeout(ok, 120));
        }
      }
    });
  }

  /* Nº da guia: QR da AT (campo G) ou os primeiros 19 algarismos do código de barras */
  function numeroGuia(raw) {
    raw = String(raw || "").trim();
    const g = raw.match(/(?:^|\*)G:([^*]+)/);
    if (g) { const n = g[1].match(/(\d+)\s*$/); if (n) return { num: n[1].slice(0, GUIA_ALGARISMOS), doc: g[1].trim(), origem: "QR da AT" }; }
    const alg = raw.replace(/\D/g, "");
    if (!alg) return null;
    return { num: alg.slice(0, GUIA_ALGARISMOS), origem: "código de barras", cortado: alg.length > GUIA_ALGARISMOS, curto: alg.length < GUIA_ALGARISMOS, todos: alg.length };
  }

  window.SJT_LEITOR = { abrir, numeroGuia, focarAoTocar };
})();
