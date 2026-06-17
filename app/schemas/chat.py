"""Schemas do endpoint de chat."""

from typing import List, Literal, Optional

from pydantic import BaseModel


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[Message] = []
    conversation_id: Optional[str] = None


class ChatResponse(BaseModel):
    response: str
    should_handoff: bool
    handoff_reason: Optional[str] = None
    intent: str
    agent_used: str
    source: str
    confidence: Optional[float] = None
    tokens_used: int = 0
    tools_called: List[str] = []
    rag_chunks_used: int = 0
    rag_sources: List[str] = []
    error: Optional[str] = None
