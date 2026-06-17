"""Camada de acesso a dados. Todo SQL cru vive AQUI — nenhum outro módulo abre
conexão nem escreve query. As classes retornam tipos de domínio (AgentConfig,
ProductRow) e forçam o escopo por agente como invariante."""

from app.repositories.agents import AgentRepository
from app.repositories.products import ProductRepository

__all__ = ["AgentRepository", "ProductRepository"]
