const CACHE="carf-v39";
const FILES=["./","index.html","pneus.html","chegadas.html","penalizacoes.html","frota.html","manifest.webmanifest","carf-icon-192.png","carf-icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:"reload"})))).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const guardar=r=>{if(r&&r.ok&&new URL(e.request.url).origin===location.origin){const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));}return r;};
  /* Páginas: rede primeiro (mostra logo as alterações), cache só quando não há rede */
  if(e.request.mode==="navigate"||e.request.destination==="document"){
    e.respondWith(fetch(e.request,{cache:"no-store"}).then(guardar).catch(()=>caches.match(e.request,{ignoreSearch:true})));
    return;
  }
  e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(hit=>{
    const rede=fetch(e.request).then(guardar).catch(()=>hit);
    return hit||rede;
  }));
});
