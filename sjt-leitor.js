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

  function estilos() {
    if (document.getElementById("sjt-leitor-css")) return;
    const st = document.createElement("style"); st.id = "sjt-leitor-css";
    st.textContent = `.sjtl{position:fixed;inset:0;z-index:60;background:#000;display:flex;flex-direction:column;gap:12px;padding:calc(12px + env(safe-area-inset-top,0px)) 16px calc(16px + env(safe-area-inset-bottom,0px));color:#eef3ef;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.sjtl[hidden]{display:none!important}
.sjtl-top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.sjtl-top b{font:700 22px "Roboto Condensed","Arial Narrow",Arial,sans-serif;text-transform:uppercase;letter-spacing:.05em;color:#B9D406}
.sjtl button{cursor:pointer}
.sjtl-x{background:none;border:1px solid #26302a;color:#eef3ef;border-radius:8px;padding:10px 14px;font:600 15px system-ui,sans-serif}
.sjtl-vid{position:relative;flex:1;min-height:0;border-radius:12px;overflow:hidden;background:#111}
.sjtl-vid video{width:100%;height:100%;object-fit:cover;display:block}
.sjtl-mira{position:absolute;inset:32% 7%;border:3px solid #B9D406;border-radius:14px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none}
.sjtl-est{margin:0;min-height:40px;font-size:15px;text-align:center}
.sjtl-est.err{color:#e0574f}
.sjtl-luz{border-radius:10px;padding:12px;font:700 17px "Roboto Condensed","Arial Narrow",Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;background:transparent;color:#B9D406;border:2px solid #B9D406}
.sjtl-man{display:grid;grid-template-columns:1fr auto;gap:8px}
.sjtl-man input{min-width:0;background:#0c0f0d;color:#eef3ef;border:1px solid #26302a;border-radius:8px;padding:12px;font:500 17px ui-monospace,Menlo,Consolas,monospace}
.sjtl-man button{border:0;border-radius:10px;padding:12px 18px;font:700 17px "Roboto Condensed","Arial Narrow",Arial,sans-serif;background:#B9D406;color:#0a0a0a}`;
    document.head.appendChild(st);
  }
  function criarUI() {
    if (ui) return ui;
    estilos();
    const el = document.createElement("div"); el.className = "sjtl"; el.hidden = true;
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
    el.innerHTML = '<div class="sjtl-top"><b></b><button type="button" class="sjtl-x">Fechar</button></div>' +
      '<div class="sjtl-vid"><video playsinline muted></video><div class="sjtl-mira"></div></div>' +
      '<p class="sjtl-est" role="status"></p><button type="button" class="sjtl-luz" hidden>Ligar lanterna</button>' +
      '<form class="sjtl-man"><input type="text" autocomplete="off" aria-label="Escrever o código"><button type="submit">OK</button></form>';
    document.body.appendChild(el);
    ui = { el, tit: el.querySelector("b"), x: el.querySelector(".sjtl-x"), video: el.querySelector("video"), est: el.querySelector(".sjtl-est"),
           luz: el.querySelector(".sjtl-luz"), form: el.querySelector("form"), input: el.querySelector("input") };
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

  function abrir({ titulo = "Ler código", texto = "Aponte para o código.", preferir = "qr" } = {}) {
    const u = criarUI();
    let stream = null, aLer = false, luz = false, fechado = false;
    const estado = (t, err) => { u.est.textContent = t; u.est.className = "sjtl-est" + (err ? " err" : ""); };
    return new Promise(resolver => {
      function parar() { aLer = false; if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } u.video.srcObject = null; }
      function fechar(valor) {
        if (fechado) return; fechado = true; parar();
        u.el.hidden = true; document.body.style.overflow = "";
        u.x.onclick = null; u.luz.onclick = null; u.form.onsubmit = null;
        document.removeEventListener("keydown", tecla); document.removeEventListener("visibilitychange", vis);
        resolver(valor);
      }
      const tecla = e => { if (e.key === "Escape") fechar(null); };
      const vis = () => { if (document.hidden) fechar(null); };
      u.tit.textContent = titulo; u.input.value = ""; u.input.placeholder = "Ou escreva o código"; u.luz.hidden = true; u.luz.textContent = "Ligar lanterna";
      u.el.hidden = false; document.body.style.overflow = "hidden";
      u.x.onclick = () => fechar(null);
      u.form.onsubmit = e => { e.preventDefault(); const v = u.input.value.trim(); if (!v) { u.input.focus(); return; } fechar(v); };
      u.luz.onclick = async () => { try { const tr = stream && stream.getVideoTracks()[0]; if (!tr) return; luz = !luz; await tr.applyConstraints({ advanced: [{ torch: luz }] }); u.luz.textContent = luz ? "Desligar lanterna" : "Ligar lanterna"; } catch (e) { u.luz.hidden = true; } };
      document.addEventListener("keydown", tecla); document.addEventListener("visibilitychange", vis);
      (async () => {
        estado("A abrir a câmara…");
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { estado("Este navegador não dá acesso à câmara. Escreva o código em baixo.", true); return; }
        try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
        catch (e) { estado(e && e.name === "NotAllowedError" ? "Sem autorização para usar a câmara. Autorize nas definições do navegador, ou escreva o código em baixo." : "Não foi possível abrir a câmara. Escreva o código em baixo.", true); return; }
        if (fechado) { parar(); return; }
        u.video.srcObject = stream; try { await u.video.play(); } catch (e) {}
        try { const tr = stream.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {}; if (cap.torch) u.luz.hidden = false;
          if (cap.focusMode && cap.focusMode.includes("continuous")) tr.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {}); } catch (e) {}
        let det;
        try { det = await obterDetetor(estado); } catch (e) { estado("Não foi possível carregar o leitor (precisa de internet da primeira vez). Escreva o código em baixo.", true); return; }
        if (fechado) return;
        estado(texto); aLer = true;
        while (aLer && !fechado) {
          if (u.video.readyState >= 2) {
            try {
              const r = await det.detect(u.video);
              if (r && r.length) {
                const qr = r.find(x => x.format === "qr_code"), barras = r.find(x => x.format !== "qr_code");
                const esc = preferir === "barras" ? (barras || qr) : (qr || barras);
                if (navigator.vibrate) navigator.vibrate(80);
                fechar(esc.rawValue); return;
              }
            } catch (e) {}
          }
          await new Promise(ok => setTimeout(ok, 180));
        }
      })();
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

  window.SJT_LEITOR = { abrir, numeroGuia };
})();
