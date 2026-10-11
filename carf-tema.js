/* OPS CARF — aspeto. A letra é sempre a Inter; as cores escolhem-se na roda de definições do hub
   (cada telemóvel guarda a sua escolha, não precisa de código).
   Carrega-se no <head> de todas as páginas, a seguir aos estilos, para se aplicar antes de a página
   aparecer (sem piscar). As cores e os acabamentos estão em carf-tema.css. */
(function () {
  "use strict";
  var TEMAS = [
    { id: "classico", nome: "Original", desc: "O aspeto de origem: preto e verde" },
    { id: "claro", nome: "Claro", desc: "Fundo claro, cartões brancos e verde sóbrio" },
    { id: "carf", nome: "CARF", desc: "As cores da empresa: azul-petróleo e verde-lima" }
  ];
  var CHAVE = "carf_tema";
  var COR_BARRA = { classico: "#0c0f0d", claro: "#ffffff", carf: "#ffffff" };
  var html = document.documentElement;

  /* Letra Inter em tudo (vem do Google Fonts e fica guardada no telemóvel; sem rede usa a letra do sistema) */
  var INTER = '"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  if (!document.getElementById("carf-inter")) {
    var l = document.createElement("link");
    l.id = "carf-inter"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";
    document.head.appendChild(l);
  }
  html.style.setProperty("--body", INTER);
  html.style.setProperty("--display", INTER);
  html.style.setProperty("--mono", INTER);

  function escolhido() {
    var t = null;
    try { t = localStorage.getItem(CHAVE); } catch (e) {}
    for (var i = 0; i < TEMAS.length; i++) if (TEMAS[i].id === t) return t;
    return TEMAS[0].id; /* Original */
  }
  function aplicar(t) {
    html.setAttribute("data-tema", t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", COR_BARRA[t]);
  }
  aplicar(escolhido());
  /* outra página/separador mudou a escolha */
  window.addEventListener("storage", function (e) { if (e.key === CHAVE) aplicar(escolhido()); });

  window.CARF_TEMA = {
    lista: TEMAS,
    atual: escolhido,
    mudar: function (t) { try { localStorage.setItem(CHAVE, t); } catch (e) {} aplicar(t); }
  };
})();
