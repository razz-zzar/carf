/* OPS CARF — gerador mínimo de PDF (sem bibliotecas, funciona offline).
   SJT_PDF.relatorio({ marca, titulo, estado, estadoOk, campos:[[rótulo, valor]], seccoes:[[título, texto]], fotos:[Blob], rodape })
   → Promise<Uint8Array> com um PDF A4, texto em Helvetica e fotografias em JPEG. */
(function () {
  "use strict";
  const W = 595.28, H = 841.89, M = 42;
  /* Larguras das letras (em milésimos do tamanho) — Helvetica e Helvetica-Bold, caracteres 32 a 126 */
  const LH = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const LB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  const ESP = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 };
  const byteDe = ch => { const c = ch.codePointAt(0); if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) return c; return ESP[ch] || 63; };
  const larguraCh = (ch, bold) => {
    const t = bold ? LB : LH; let c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) return t[c - 32];
    const base = ch.normalize("NFD")[0]; c = base.codePointAt(0);
    if (c >= 32 && c <= 126) return t[c - 32];
    return ch === "€" ? 556 : ch === "—" ? 1000 : ch === "·" ? 278 : 556;
  };
  const largura = (txt, tam, bold) => [...String(txt)].reduce((a, ch) => a + larguraCh(ch, bold), 0) * tam / 1000;
  const hex = txt => "<" + [...String(txt)].map(ch => byteDe(ch).toString(16).padStart(2, "0")).join("") + ">";
  function quebrar(txt, max, tam, bold) {
    const linhas = [];
    for (const par of String(txt == null ? "" : txt).replace(/\r/g, "").split("\n")) {
      let atual = "";
      for (const palavra of par.split(/\s+/).filter(Boolean)) {
        let p = palavra;
        while (largura(p, tam, bold) > max) { /* palavra maior que a linha: corta */
          let i = p.length; while (i > 1 && largura(p.slice(0, i), tam, bold) > max) i--;
          if (atual) { linhas.push(atual); atual = ""; }
          linhas.push(p.slice(0, i)); p = p.slice(i);
        }
        const tent = atual ? atual + " " + p : p;
        if (largura(tent, tam, bold) <= max) atual = tent; else { linhas.push(atual); atual = p; }
      }
      linhas.push(atual);
    }
    return linhas;
  }
  async function jpeg(blob, lado = 1600) {
    let img;
    try { img = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
    catch (e) { img = await new Promise((ok, nok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = nok; i.src = URL.createObjectURL(blob); }); }
    const k = Math.min(1, lado / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    const b = await new Promise((ok, nok) => c.toBlob(x => x ? ok(x) : nok(new Error("imagem")), "image/jpeg", 0.85));
    return { bytes: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height };
  }
  const n2 = v => (Math.round(v * 100) / 100).toString();

  async function relatorio({ marca = "", titulo = "", estado = "", estadoOk = false, campos = [], seccoes = [], fotos = [], rodape = "" }) {
    const imgs = [];
    for (const f of fotos) { try { imgs.push(await jpeg(f)); } catch (e) { imgs.push(null); } }
    const paginas = []; let ops = null, y = 0;
    const cor = (r, g, b) => n2(r) + " " + n2(g) + " " + n2(b);
    const VERDE = cor(0.725, 0.831, 0.024), CINZA = cor(0.42, 0.45, 0.43), PRETO = cor(0.07, 0.08, 0.07), LINHA = cor(0.85, 0.87, 0.85);
    const texto = (x, yy, txt, tam, bold, c) => ops.push("BT /" + (bold ? "F2" : "F1") + " " + n2(tam) + " Tf " + (c || PRETO) + " rg " + n2(x) + " " + n2(yy) + " Td " + hex(txt) + " Tj ET");
    const ret = (x, yy, w, h, c) => ops.push(c + " rg " + n2(x) + " " + n2(yy) + " " + n2(w) + " " + n2(h) + " re f");
    const linha = (x1, y1, x2, c, esp) => ops.push(c + " RG " + n2(esp || 0.6) + " w " + n2(x1) + " " + n2(y1) + " m " + n2(x2) + " " + n2(y1) + " l S");
    function novaPagina() {
      ops = []; paginas.push({ ops, imgs: [] }); y = H - M;
      ret(0, H - 10, W, 10, VERDE);
      if (paginas.length > 1) { texto(M, y - 10, titulo, 10, true, CINZA); y -= 26; }
    }
    const garantir = h => { if (y - h < M + 24) novaPagina(); };
    novaPagina();
    /* cabeçalho */
    texto(M, y - 10, marca, 10, true, CINZA); y -= 34;
    const tl = quebrar(titulo, W - 2 * M - 110, 20, true);
    if (estado) {
      const lw = largura(estado, 11, true) + 18;
      ret(W - M - lw, y - 4, lw, 22, estadoOk ? VERDE : cor(0.88, 0.34, 0.31));
      texto(W - M - lw + 9, y + 3, estado, 11, true, estadoOk ? PRETO : cor(1, 1, 1));
    }
    for (const l of tl) { texto(M, y, l, 20, true); y -= 24; }
    y -= 6; linha(M, y, W - M, VERDE, 1.5); y -= 18;
    /* campos */
    const cw = 130, vx = M + cw, vw = W - M - vx;
    for (const [rot, val] of campos) {
      const ls = quebrar(val === "" || val == null ? "—" : String(val), vw, 11, false);
      const h = ls.length * 14 + 8; garantir(h);
      texto(M, y - 1, String(rot).toUpperCase(), 8.5, true, CINZA);
      ls.forEach((l, i) => texto(vx, y - i * 14, l, 11, false));
      y -= h; linha(M, y + 4, W - M, LINHA);
    }
    /* secções de texto (descrição, resolução) */
    for (const [tit, txt] of seccoes) {
      if (!txt) continue;
      y -= 12; garantir(40);
      texto(M, y, String(tit).toUpperCase(), 11, true, VERDE); y -= 18;
      for (const l of quebrar(txt, W - 2 * M, 11, false)) { garantir(16); texto(M, y, l, 11, false); y -= 15; }
    }
    /* fotografias: duas por linha */
    if (imgs.length) {
      y -= 12; garantir(60);
      texto(M, y, "FOTOGRAFIAS (" + imgs.length + ")", 11, true, VERDE); y -= 14;
      const gap = 12, cel = (W - 2 * M - gap) / 2, hmax = 300;
      for (let i = 0; i < imgs.length; i += 2) {
        const par = imgs.slice(i, i + 2).map(im => { if (!im) return null; const k = Math.min(cel / im.w, hmax / im.h); return { im, w: im.w * k, h: im.h * k }; });
        const alt = Math.max(40, ...par.map(p => p ? p.h : 40));
        garantir(alt + 8);
        par.forEach((p, j) => {
          const x = M + j * (cel + gap);
          if (!p) { texto(x, y - 20, "(fotografia indisponível)", 10, false, CINZA); return; }
          const nome = "Im" + (paginas[paginas.length - 1].imgs.length + 1);
          paginas[paginas.length - 1].imgs.push({ nome, im: p.im });
          ops.push("q " + n2(p.w) + " 0 0 " + n2(p.h) + " " + n2(x) + " " + n2(y - p.h) + " cm /" + nome + " Do Q");
        });
        y -= alt + 10;
      }
    }
    /* montar o ficheiro */
    const enc = new TextEncoder(), partes = [], offs = [];
    let tam = 0;
    const add = d => { const b = typeof d === "string" ? enc.encode(d) : d; partes.push(b); tam += b.length; };
    const objs = []; const novoObj = () => { objs.push(null); return objs.length; };
    const CAT = novoObj(), PAGS = novoObj(), F1 = novoObj(), F2 = novoObj();
    const corpos = {};
    corpos[F1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    corpos[F2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    const pagIds = [], fluxos = {};
    const total = paginas.length;
    paginas.forEach((pg, i) => {
      ops = pg.ops;
      if (rodape) texto(M, 22, rodape, 8, false, CINZA);
      const pt = "Página " + (i + 1) + " de " + total; texto(W - M - largura(pt, 8, false), 22, pt, 8, false, CINZA);
      const xo = pg.imgs.map(({ nome, im }) => { const id = novoObj(); fluxos[id] = { dic: "<< /Type /XObject /Subtype /Image /Width " + im.w + " /Height " + im.h + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + im.bytes.length + " >>", dados: im.bytes }; return "/" + nome + " " + id + " 0 R"; });
      const cont = novoObj(), conteudo = enc.encode(pg.ops.join("\n"));
      fluxos[cont] = { dic: "<< /Length " + conteudo.length + " >>", dados: conteudo };
      const pid = novoObj(); pagIds.push(pid);
      corpos[pid] = "<< /Type /Page /Parent " + PAGS + " 0 R /MediaBox [0 0 " + n2(W) + " " + n2(H) + "] /Resources << /Font << /F1 " + F1 + " 0 R /F2 " + F2 + " 0 R >>" + (xo.length ? " /XObject << " + xo.join(" ") + " >>" : "") + " >> /Contents " + cont + " 0 R >>";
    });
    corpos[CAT] = "<< /Type /Catalog /Pages " + PAGS + " 0 R >>";
    corpos[PAGS] = "<< /Type /Pages /Kids [" + pagIds.map(p => p + " 0 R").join(" ") + "] /Count " + pagIds.length + " >>";
    add("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    for (let id = 1; id <= objs.length; id++) {
      offs[id] = tam;
      if (fluxos[id]) { add(id + " 0 obj\n" + fluxos[id].dic + "\nstream\n"); add(fluxos[id].dados); add("\nendstream\nendobj\n"); }
      else add(id + " 0 obj\n" + corpos[id] + "\nendobj\n");
    }
    const xref = tam;
    let x = "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
    for (let id = 1; id <= objs.length; id++) x += String(offs[id]).padStart(10, "0") + " 00000 n \n";
    add(x + "trailer\n<< /Size " + (objs.length + 1) + " /Root " + CAT + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
    const out = new Uint8Array(tam); let o = 0; for (const p of partes) { out.set(p, o); o += p.length; }
    return out;
  }
  window.SJT_PDF = { relatorio };
})();
