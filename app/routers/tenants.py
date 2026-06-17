"""Rotas de tenants (plataforma) e de membros (RBAC) — pontos 19 e 8.

  * Plataforma (X-Admin-Key): criar / listar / excluir TENANTS.
  * Tenant (X-API-Key de tenant/owner): ver o tenant e gerir membros.

Criar um tenant gera sua api_key master e o primeiro usuário OWNER (ambas as
chaves são exibidas só na resposta da criação).
"""

from typing import List

from fastapi import APIRouter, Depends

from app.routers.deps import require_member, require_owner, require_platform_admin
from app.schemas import (
    MemberCreate,
    MemberCreated,
    MemberInfo,
    TenantCreate,
    TenantCreated,
    TenantPublic,
)
from app.services import TenantService, get_tenant_service

router = APIRouter(prefix="/v1/tenants", tags=["tenants"])


# --- Plataforma (X-Admin-Key) ----------------------------------------------- #

@router.post("", response_model=TenantCreated, status_code=201,
             dependencies=[Depends(require_platform_admin)])
def create_tenant(payload: TenantCreate, svc: TenantService = Depends(get_tenant_service)):
    tenant, owner = svc.create(payload.model_dump())
    return TenantCreated(
        id=tenant.id, name=tenant.name, created_at=str(tenant.created_at),
        api_key=tenant.api_key, owner_email=owner.email, owner_api_key=owner.api_key,
    )


@router.get("", response_model=List[TenantPublic],
            dependencies=[Depends(require_platform_admin)])
def list_tenants(svc: TenantService = Depends(get_tenant_service)):
    return [TenantPublic(id=t.id, name=t.name, created_at=str(t.created_at)) for t in svc.list()]


@router.delete("/{tenant_id}", dependencies=[Depends(require_platform_admin)])
def delete_tenant(tenant_id: str, svc: TenantService = Depends(get_tenant_service)):
    """Exclui o tenant, seus agentes/produtos (cascade) e a base RAG deles."""
    return svc.delete(tenant_id)


# --- Tenant / membros (X-API-Key) ------------------------------------------- #

@router.get("/{tenant_id}", response_model=TenantPublic,
            dependencies=[Depends(require_member)])
def get_tenant(tenant_id: str, svc: TenantService = Depends(get_tenant_service)):
    t = svc.get(tenant_id)
    return TenantPublic(id=t.id, name=t.name, created_at=str(t.created_at))


@router.get("/{tenant_id}/members", response_model=List[MemberInfo],
            dependencies=[Depends(require_owner)])
def list_members(tenant_id: str, svc: TenantService = Depends(get_tenant_service)):
    return [MemberInfo(**m) for m in svc.list_members(tenant_id)]


@router.post("/{tenant_id}/members", response_model=MemberCreated, status_code=201,
             dependencies=[Depends(require_owner)])
def add_member(tenant_id: str, payload: MemberCreate,
               svc: TenantService = Depends(get_tenant_service)):
    r = svc.add_member(tenant_id, payload.email, payload.role, payload.name)
    return MemberCreated(user_id=r["user_id"], email=r["email"], name=payload.name,
                         role=r["role"], api_key=r["api_key"])


@router.delete("/{tenant_id}/members/{user_id}", dependencies=[Depends(require_owner)])
def remove_member(tenant_id: str, user_id: str,
                  svc: TenantService = Depends(get_tenant_service)):
    svc.remove_member(tenant_id, user_id)
    return {"removed": user_id}
