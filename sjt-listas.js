/* OPS CARF — listas de origem do armazém SJT.
   Servem de valores iniciais: cada armazém tem as suas listas na página de gestão,
   e as apps usam as do armazém em que o supervisor entrou. */
window.SJT_LISTAS_SJT = {
  voltasC: ["1201","1602","1603","1204","1205","1311","1112","1113","1314","1315","1316","1317","1318","1419","1420","1123","1624","1627","1330","1633","1334","1235","1636","1337","1638","1639","1641","1445","Recolha Santogal","AS Parts Seixal","Arrasto Norte","Carro Leiria","Carro extra Leiria"],
  voltasS: ["1201","1602","1603","1204","1205","1311","1112","1113","1314","1315","1316","1317","1318","1419","1420","1123","1624","1627","1330","1633","1334","1235","1636","1337","1638","1639","1641","1445","PSAR"],
  interruptor: ["Carro extra Leiria"],
  voltasPneus: ["1205","1311","1112","1314","1318","1633","1639","Arrasto Norte"],
  matriz: {
    "1201":"Exoticspring","1602":"LG","1603":"Exoticspring","1204":"Exoticspring","1205":"LG",
    "1311":"TA","1112":"TA","1113":"TA","1315":"TA","1318":"TA",
    "1419":"LG","1420":"LG","1222":"SantanaRace","1123":"LG","1624":"TA",
    "1627":"LG","1330":"TA","1633":"LG","1334":"CARF","1235":"Exoticspring",
    "1636":"LG","1337":"TA","1638":"Km Forasteiros","1639":"LG","1340":"TA",
    "1641":"LG","1145":"TA","1445":"TA"
  },
  /* valor: número em € | "nao_pago" | "reembolso" (reembolso + 25%) */
  motivos: [
    ["Chegada tardia no início do dia",25],["Estafeta sem farda",25],["Saída tardia para distribuição",25],
    ["Estafeta não presente no fecho do dia","nao_pago"],["Mercadoria sem scan de carga",25],["Mercadoria sem scan de entrega",25],
    ["Mercadoria sem scan de não entrega",25],["Falha de scan de recolha",25],["Falha de entrega inaceitável",30],
    ["Entrega sem recolha de assinatura",30],["Guia manual mal preenchida",15],["Entrega de mercadoria sem receber reembolso","reembolso"],
    ["Manuseamento incorreto das mercadorias",25],["Recolha não efetuada",50],["Estafeta incontactável",15],
    ["Viatura não limpa",25],["Viatura não padronizada",30],["Fumar no armazém",30]
  ]
};
