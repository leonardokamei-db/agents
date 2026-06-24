/**
 * Copy voltada ao usuário final, centralizada (porta `app/messages.py`).
 * Um lugar só para ajustar mensagens e preparar i18n / override por tenant.
 */

// Handoff genérico quando o assistente decide transferir.
export const HANDOFF_GENERIC =
  "Vou transferir você para um atendente humano para ajudar com isso.";

// Limite de turnos / erro interno -> fallback.
export const FALLBACK_HANDOFF =
  "Para te atender melhor, vou transferir você para um de nossos atendentes " +
  "humanos. Um momento, por favor.";

// Erro interno no processamento (capturado pelo orchestrator).
export const ERROR_INTERNAL =
  "Desculpe, ocorreu um erro. Vou transferir você para um atendente.";

// Escalonamento determinístico de suporte (palavra-chave forte).
export const ESCALATION_SUPPORT =
  "Entendo que isso é importante e quero garantir que seja resolvido da melhor " +
  "forma. Vou transferir você para um atendente humano que poderá cuidar disso " +
  "agora mesmo.";

// Agente não conseguiu consultar o catálogo (skills de catálogo).
export const DEGRADED_CATALOG =
  "Desculpe, tive um problema ao consultar o catálogo. Você pode reformular " +
  "informando o nome do produto e a quantidade? Se preferir, posso transferir " +
  "você para um atendente.";

// Pedido registrado (reserva feita) — encaminhar para pagamento.
export const ORDER_CONFIRMED =
  "Seu pedido foi registrado. Vou transferir você para finalizar o pagamento.";

// Reserva indisponível em catálogo externo.
export const RESERVE_EXTERNAL_UNAVAILABLE =
  "Reserva indisponível: catálogo externo. Encaminhe ao atendente.";
