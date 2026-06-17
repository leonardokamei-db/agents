"""Copy voltada ao usuário final, centralizada (ponto 5).

Antes essas strings estavam duplicadas e divergentes em order.py, support.py,
fallback.py, orchestrator.py, base.py e catalog.py. Centralizar aqui permite
mudar a mensagem padrão num lugar só e prepara o terreno para i18n / sobrescrita
por tenant no futuro.
"""

# Handoff genérico quando o assistente decide transferir.
HANDOFF_GENERIC = "Vou transferir você para um atendente humano para ajudar com isso."

# Limite de turnos / erro interno -> fallback.
FALLBACK_HANDOFF = (
    "Para te atender melhor, vou transferir você para um de nossos atendentes "
    "humanos. Um momento, por favor."
)

# Erro interno no processamento (capturado pelo orchestrator).
ERROR_INTERNAL = "Desculpe, ocorreu um erro. Vou transferir você para um atendente."

# Escalonamento determinístico de suporte (palavra-chave forte).
ESCALATION_SUPPORT = (
    "Entendo que isso é importante e quero garantir que seja resolvido da melhor "
    "forma. Vou transferir você para um atendente humano que poderá cuidar disso "
    "agora mesmo."
)

# OrderAgent não conseguiu consultar o catálogo.
DEGRADED_CATALOG = (
    "Desculpe, tive um problema ao consultar o catálogo. Você pode reformular "
    "informando o nome do produto e a quantidade? Se preferir, posso transferir "
    "você para um atendente."
)

# Pedido registrado (reserva feita) — encaminhar para pagamento.
ORDER_CONFIRMED = "Seu pedido foi registrado. Vou transferir você para finalizar o pagamento."

# Reserva indisponível em catálogo externo.
RESERVE_EXTERNAL_UNAVAILABLE = (
    "Reserva indisponível: catálogo externo. Encaminhe ao atendente."
)
