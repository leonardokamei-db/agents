"""Ponto de entrada compatível com o Procfile/railway.toml (`uvicorn server:app`).
A aplicação real vive em app/main.py."""

from app.main import app  # noqa: F401
