"""Schemas de tenants, usuários e memberships (pontos 19, 8)."""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class TenantCreate(BaseModel):
    id: Optional[str] = Field(default=None, description="Slug do tenant (gerado do nome se omitido)")
    name: str
    owner_email: str
    owner_name: str = ""


class TenantPublic(BaseModel):
    id: str
    name: str
    created_at: str


class TenantCreated(TenantPublic):
    """Retornado só na criação — inclui as chaves geradas (exibidas uma vez)."""
    api_key: str          # chave master do tenant (chat/consumo)
    owner_email: str
    owner_api_key: str    # chave do primeiro owner (gestão)


class MemberCreate(BaseModel):
    email: str
    role: Literal["owner", "member"] = "member"
    name: str = ""


class MemberInfo(BaseModel):
    user_id: str
    email: str
    name: str = ""
    role: str


class MemberCreated(MemberInfo):
    """Inclui a api_key do usuário (exibida só ao criar/convidar)."""
    api_key: str
