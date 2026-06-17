"""Blip Agent — backend multi-tenant de agentes de atendimento.

Camadas:
  app.config       — variáveis de ambiente e constantes globais.
  app.db           — conexão SQLite + schema + migração multi-tenant.
  app.domain       — tipos de domínio (Tenant, User, AgentConfig, ...).
  app.repositories — acesso a dados (todo o SQL cru vive aqui).
  app.services     — regra de negócio entre routers e repositórios.
  app.schemas      — modelos Pydantic da API.
  app.catalog      — produtos: SQLite interno OU API externa do cliente.
  app.tasks        — ingestão via fila (Celery+Redis) com fallback síncrono.
  app.llm          — cliente Groq.
  app.embeddings   — embeddings hospedados (Jina).
  app.rag          — vector store (sqlite-vec) para FAQs/PDFs.
  app.prompts      — construção de prompts compactos (economia de tokens).
  app.agents       — agentes especializados (faq, suporte, pedidos, ...).
  app.orchestrator — classificação de intenção + roteamento.
  app.logging_ctx  — correlação de log (request_id + tenant).
  app.routers      — endpoints FastAPI (tenants, agentes, produtos, conhecimento).
  app.main         — aplicação FastAPI.
"""
