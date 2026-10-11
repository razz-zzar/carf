/* OPS CARF — temas de cor. Cada telemóvel guarda o seu tema (não precisa de código).
   Este ficheiro carrega-se no <head> de todas as páginas, a seguir aos estilos, para o tema
   se aplicar antes de a página aparecer (sem piscar). As cores de cada tema estão em carf-tema.css. */
(function () {
  "use strict";
  var TEMAS = [
    { id: "claro", nome: "Claro", desc: "Fundo claro, cartões brancos e verde sóbrio" },
    { id: "escuro", nome: "Escuro suave", desc: "Cinzento escuro, sem preto puro nem néon" },
    { id: "classico", nome: "Clássico", desc: "O aspeto original: preto e verde CARF" },
    { id: "auto", nome: "Automático", desc: "Claro ou escuro conforme o telemóvel" }
  ];
  var PADRAO = "classico", CHAVE = "carf_tema";
  var COR_BARRA = { claro: "#ffffff", escuro: "#1b211e", classico: "#0c0f0d" };
  var escuroSistema = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function escolhido() {
    var t = null;
    try { t = localStorage.getItem(CHAVE); } catch (e) {}
    for (var i = 0; i < TEMAS.length; i++) if (TEMAS[i].id === t) return t;
    return PADRAO;
  }
  function real(t) { return t === "auto" ? (escuroSistema && escuroSistema.matches ? "escuro" : "claro") : t; }
  function aplicar(t) {
    var r = real(t), html = document.documentElement;
    html.setAttribute("data-tema", r);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", COR_BARRA[r]);
  }
  aplicar(escolhido());
  if (escuroSistema) {
    var ouvir = function () { if (escolhido() === "auto") aplicar("auto"); };
    if (escuroSistema.addEventListener) escuroSistema.addEventListener("change", ouvir);
    else if (escuroSistema.addListener) escuroSistema.addListener(ouvir);
  }
  /* outra página/separador mudou o tema */
  window.addEventListener("storage", function (e) { if (e.key === CHAVE) aplicar(escolhido()); });

  window.CARF_TEMA = {
    lista: TEMAS,
    atual: escolhido,
    mudar: function (t) {
      try { localStorage.setItem(CHAVE, t); } catch (e) {}
      aplicar(t);
    }
  };
})();
