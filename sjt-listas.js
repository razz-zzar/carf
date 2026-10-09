/* OPS CARF — dados base comuns a todos os polos.
   Só os motivos de penalização: as voltas e os subcontratados são próprios de cada polo
   e preenchem-se na página de gestão. */
window.SJT_DADOS_BASE = {
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
