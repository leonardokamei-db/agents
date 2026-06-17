"""Contexto de log por requisição (ponto 9): request_id + tenant no formatter.

Um middleware preenche os contextvars no início de cada requisição; o filtro os
injeta em TODO LogRecord, então qualquer log (em qualquer módulo) sai
correlacionado por requisição e tenant — sem precisar passar ids à mão. O nível
vem de LOG_LEVEL (ver docs/DEBUG.md).
"""

import logging
from contextvars import ContextVar

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
tenant_id_var: ContextVar[str] = ContextVar("tenant_id", default="-")

LOG_FORMAT = (
    "%(asctime)s  %(levelname)s  [req=%(request_id)s tenant=%(tenant_id)s] "
    "%(name)s  %(message)s"
)


class ContextFilter(logging.Filter):
    """Anexa request_id/tenant_id a cada registro (default '-' fora de requisição)."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        record.tenant_id = tenant_id_var.get()
        return True


def configure_logging(level: str = "INFO") -> None:
    """Reconfigura o root logger com o formato correlacionado e o nível dado."""
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    handler.addFilter(ContextFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level, logging.INFO))


def tenant_from_path(path: str) -> str:
    """Extrai o tenant de /v1/tenants/{tenant_id}/... (para o middleware, que
    roda antes de o roteamento resolver os path params)."""
    parts = path.strip("/").split("/")
    if len(parts) >= 3 and parts[0] == "v1" and parts[1] == "tenants":
        return parts[2]
    return "-"
