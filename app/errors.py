"""Hierarquia única de erros de domínio (ponto 10).

Em vez de cada router levantar HTTPException com status cru e cada camada filha
estourar ValueError/RuntimeError genéricos, o domínio levanta AppError tipado e
um único exception_handler (app/main.py) o serializa com o status correto.

Regra degrade-vs-propagate (decisão C2 da revisão):
  * No fluxo de CHAT, erros degradam para handoff (o Orchestrator captura e
    responde 200) — a experiência do usuário final vem antes do status HTTP.
  * Nos demais endpoints (admin/config/knowledge/products), AppError PROPAGA e
    o handler devolve o status tipado.
"""


class AppError(Exception):
    """Base de todos os erros de domínio. status_code e code viram a resposta."""
    status_code = 500
    code = "internal_error"

    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"


class ValidationError(AppError):
    status_code = 400
    code = "validation_error"


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"


class ForbiddenError(AppError):
    status_code = 403
    code = "forbidden"


class EmbeddingUnavailableError(AppError):
    status_code = 503
    code = "embedding_unavailable"
