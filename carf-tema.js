/* OPS CARF — aspeto (cores e letra). Cada telemóvel guarda a sua escolha (não precisa de código).
   Carrega-se no <head> de todas as páginas, a seguir aos estilos, para se aplicar antes de a página
   aparecer (sem piscar). As cores e os acabamentos estão em carf-tema.css. */
(function () {
  "use strict";
  var TEMAS = [
    { id: "classico", nome: "Clássico", desc: "O aspeto original: preto e verde CARF" },
    { id: "claro", nome: "Claro", desc: "Fundo claro, cartões brancos e verde sóbrio" },
    { id: "escuro", nome: "Escuro suave", desc: "Cinzento escuro, sem preto puro nem néon" },
    { id: "auto", nome: "Automático", desc: "Claro ou escuro conforme o telemóvel" }
  ];
  /* Letras: g = família no Google Fonts (sem internet usa a letra do telemóvel) */
  var SIS = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  var FONTES = [
    { id: "original", nome: "Original", desc: "Títulos estreitos em maiúsculas" },
    { id: "sistema", nome: "Sistema", desc: "A letra do próprio telemóvel, limpa e rápida", pilha: SIS },
    { id: "inter", nome: "Inter", desc: "Moderna, feita para ler em ecrãs", g: "Inter:wght@400;500;600;700", pilha: '"Inter",' + SIS },
    { id: "plex", nome: "IBM Plex Sans", desc: "Técnica e séria, estilo empresarial", g: "IBM+Plex+Sans:wght@400;500;600;700", pilha: '"IBM Plex Sans",' + SIS },
    { id: "barlow", nome: "Barlow", desc: "Inspirada na sinalética das estradas", g: "Barlow:wght@400;500;600;700", pilha: '"Barlow",' + SIS },
    { id: "manrope", nome: "Manrope", desc: "Geométrica e elegante", g: "Manrope:wght@400;500;600;700;800", pilha: '"Manrope",' + SIS }
  ];
  var C_TEMA = "carf_tema", C_FONTE = "carf_fonte";
  var COR_BARRA = { claro: "#ffffff", escuro: "#1b211e", classico: "#0c0f0d" };
  var escuroSistema = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var html = document.documentElement;

  function ler(chave, lista) {
    var v = null;
    try { v = localStorage.getItem(chave); } catch (e) {}
    for (var i = 0; i < lista.length; i++) if (lista[i].id === v) return v;
    return lista[0].id; /* o primeiro de cada lista é o de origem */
  }
  function achar(lista, id) { for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return lista[i]; return lista[0]; }

  /* ---- cores ---- */
  function real(t) { return t === "auto" ? (escuroSistema && escuroSistema.matches ? "escuro" : "claro") : t; }
  function aplicarTema(t) {
    var r = real(t);
    html.setAttribute("data-tema", r);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", COR_BARRA[r]);
  }
  /* ---- letra ---- */
  function carregarFonte(f) {
    if (!f.g || document.getElementById("carf-fonte-" + f.id)) return;
    var l = document.createElement("link");
    l.id = "carf-fonte-" + f.id; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=" + f.g + "&display=swap";
    document.head.appendChild(l);
  }
  function aplicarFonte(id) {
    var f = achar(FONTES, id);
    html.setAttribute("data-fonte", f.id);
    html.setAttribute("data-letra", f.id === "original" ? "original" : "nova");
    if (f.pilha) { carregarFonte(f); html.style.setProperty("--body", f.pilha); html.style.setProperty("--display", f.pilha); }
    else { html.style.removeProperty("--body"); html.style.removeProperty("--display"); }
  }

  aplicarTema(ler(C_TEMA, TEMAS));
  aplicarFonte(ler(C_FONTE, FONTES));
  if (escuroSistema) {
    var ouvir = function () { if (ler(C_TEMA, TEMAS) === "auto") aplicarTema("auto"); };
    if (escuroSistema.addEventListener) escuroSistema.addEventListener("change", ouvir);
    else if (escuroSistema.addListener) escuroSistema.addListener(ouvir);
  }
  /* outra página/separador mudou a escolha */
  window.addEventListener("storage", function (e) {
    if (e.key === C_TEMA) aplicarTema(ler(C_TEMA, TEMAS));
    if (e.key === C_FONTE) aplicarFonte(ler(C_FONTE, FONTES));
  });

  window.CARF_TEMA = {
    lista: TEMAS,
    atual: function () { return ler(C_TEMA, TEMAS); },
    mudar: function (t) { try { localStorage.setItem(C_TEMA, t); } catch (e) {} aplicarTema(t); },
    fontes: FONTES,
    fonteAtual: function () { return ler(C_FONTE, FONTES); },
    mudarFonte: function (id) { try { localStorage.setItem(C_FONTE, id); } catch (e) {} aplicarFonte(id); },
    /* para mostrar as amostras na janela de definições */
    carregarTodas: function () { for (var i = 0; i < FONTES.length; i++) carregarFonte(FONTES[i]); }
  };
})();
