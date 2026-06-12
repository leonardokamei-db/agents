"""Blip Agent — backend multi-tenant de agentes de atendimento.

Camadas:
  app.config      — variáveis de ambiente e constantes globais.
  app.db          — conexão SQLite + criação de schema (agents, products).
  app.schemas     — modelos Pydantic da API.
  app.tenants     — CRUD de agentes/tenants (tabela `agents`).
  app.catalog     — produtos: SQLite interno OU API externa do cliente.
  app.llm         — cliente Groq.
  app.embeddings  — embeddings hospedados (Jina).
  app.rag         — vector store (sqlite-vec) para FAQs/PDFs.
  app.prompts     — construção de prompts compactos (economia de tokens).
  app.agents      — agentes especializados (faq, suporte, pedidos, ...).
  app.orchestrator— classificação de intenção + roteamento.
  app.routers     — endpoints FastAPI.
  app.main        — aplicação FastAPI.
"""
