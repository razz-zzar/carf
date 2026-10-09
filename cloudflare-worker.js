// OPS SJT — intermediário para as fichas de pneus da UE (EPREL)
// A UE não deixa a app ler a ficha diretamente a partir do telemóvel (CORS).
// Este pequeno serviço vai buscar a ficha à UE e devolve-a à app.
// Só aceita números de ficha de pneus e só responde às páginas do OPS SJT.
//
// Como publicar (uma vez, conta gratuita da Cloudflare):
// 1. dash.cloudflare.com → Workers & Pages → Create → Create Worker → nome "eprel-sjt" → Deploy
// 2. Edit code → apagar tudo → colar este ficheiro → Deploy
// 3. Copiar o endereço que aparece (ex. https://eprel-sjt.<conta>.workers.dev)

const ORIGENS = [
  "https://razz-zzar.github.io",
  "https://raw.githack.com",
  "https://rawcdn.githack.com",
];

export default {
  async fetch(request) {
    const origem = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGENS.includes(origem) ? origem : ORIGENS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("Método não permitido", { status: 405, headers: cors });

    // Endereço esperado: https://eprel-sjt.<conta>.workers.dev/909522
    const id = new URL(request.url).pathname.replace(/\//g, "");
    if (!/^\d{1,10}$/.test(id)) return new Response("Número EPREL inválido", { status: 400, headers: cors });

    const r = await fetch("https://eprel.ec.europa.eu/api/products/tyres/" + id, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 86400, cacheEverything: true }, // fichas guardadas 1 dia na Cloudflare
    });
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
  },
};
