"""Schemas da base de conhecimento (RAG)."""

from pydantic import BaseModel


class TextIngest(BaseModel):
    source_name: str
    text: str
