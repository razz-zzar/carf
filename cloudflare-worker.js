// OPS SJT — intermediário para as fichas de pneus da UE (EPREL)
// A UE não deixa a app ler a ficha diretamente a partir do telemóvel (CORS).
// Este pequeno serviço vai buscar a ficha à UE e devolve-a à app.
// Só aceita números de ficha de pneus e só responde às páginas do OPS SJT.
//
// Como publicar (uma vez, conta gratuita da Cloudflare):
// 1. dash.cloudflare.com → Workers & Pages → Create → Start with Hello World! → nome "eprel-sjt" → Deploy
// 2. Edit code → apagar tudo → colar este ficheiro → Deploy
// 3. Testar: https://eprel-sjt.<conta>.workers.dev/909522 deve mostrar os dados de um Michelin Pilot Sport 5

const ORIGENS = [
  "https://razz-zzar.github.io",
  "https://raw.githack.com",
  "https://rawcdn.githack.com",
];

// A UE recusa pedidos sem os cabeçalhos de um browser normal; o pedido é feito
// como o próprio site público da EPREL faz quando se abre a ficha do pneu.
const cabecalhosUE = id => ({
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
  "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
  "Referer": "https://eprel.ec.europa.eu/screen/product/tyres/" + id,
  "Origin": "https://eprel.ec.europa.eu",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
});

export default {
  async fetch(request) {
    const origem = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGENS.includes(origem) ? origem : ORIGENS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    const json = (obj, status) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
    });
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ erro: "Método não permitido" }, 405);

    // Endereço esperado: https://eprel-sjt.<conta>.workers.dev/909522
    const id = new URL(request.url).pathname.replace(/\//g, "");
    if (!/^\d{1,10}$/.test(id)) return json({ erro: "Número EPREL inválido" }, 400);

    let r;
    try {
      r = await fetch("https://eprel.ec.europa.eu/api/products/tyres/" + id, {
        headers: cabecalhosUE(id),
        cf: { cacheTtl: 86400, cacheEverything: true }, // fichas guardadas 1 dia na Cloudflare
      });
    } catch (e) {
      return json({ erro: "Sem ligação à UE" }, 502);
    }
    const texto = await r.text();
    if (!r.ok || !texto.trim().startsWith("{")) {
      return json({ erro: "A UE recusou o pedido", estadoUE: r.status }, 502);
    }
    return new Response(texto, {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
  },
};
