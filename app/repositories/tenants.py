"""Repositórios de tenant/user/membership — todo o SQL dessas tabelas.

São a base do modelo multi-tenant (ponto 19) e do RBAC (ponto 8): o tenant é
dono dos agentes, o usuário se vincula ao tenant por uma membership com papel.
"""

from app.db import read_connection, transaction
from app.domain import Membership, Tenant, User


class TenantRepository:
    def get(self, tenant_id: str) -> Tenant | None:
        with read_connection() as conn:
            row = conn.execute("SELECT * FROM tenants WHERE id = ?", (tenant_id,)).fetchone()
            return Tenant.from_row(row) if row else None

    def get_by_api_key(self, api_key: str) -> Tenant | None:
        with read_connection() as conn:
            row = conn.execute("SELECT * FROM tenants WHERE api_key = ?", (api_key,)).fetchone()
            return Tenant.from_row(row) if row else None

    def list(self) -> list[Tenant]:
        with read_connection() as conn:
            rows = conn.execute("SELECT * FROM tenants ORDER BY created_at").fetchall()
            return [Tenant.from_row(r) for r in rows]

    def exists(self, tenant_id: str) -> bool:
        with read_connection() as conn:
            return conn.execute("SELECT 1 FROM tenants WHERE id = ?", (tenant_id,)).fetchone() is not None

    def insert(self, tenant_id: str, name: str, api_key: str) -> None:
        with transaction() as conn:
            conn.execute(
                "INSERT INTO tenants (id, name, api_key) VALUES (?, ?, ?)",
                (tenant_id, name, api_key),
            )

    def delete(self, tenant_id: str) -> bool:
        with transaction() as conn:
            return conn.execute("DELETE FROM tenants WHERE id = ?", (tenant_id,)).rowcount > 0


class UserRepository:
    def get(self, user_id: str) -> User | None:
        with read_connection() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            return User.from_row(row) if row else None

    def get_by_api_key(self, api_key: str) -> User | None:
        with read_connection() as conn:
            row = conn.execute("SELECT * FROM users WHERE api_key = ?", (api_key,)).fetchone()
            return User.from_row(row) if row else None

    def get_by_email(self, email: str) -> User | None:
        with read_connection() as conn:
            row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            return User.from_row(row) if row else None

    def insert(self, user_id: str, email: str, name: str, api_key: str) -> None:
        with transaction() as conn:
            conn.execute(
                "INSERT INTO users (id, email, name, api_key) VALUES (?, ?, ?, ?)",
                (user_id, email, name, api_key),
            )


class MembershipRepository:
    def get(self, tenant_id: str, user_id: str) -> Membership | None:
        with read_connection() as conn:
            row = conn.execute(
                "SELECT * FROM memberships WHERE tenant_id = ? AND user_id = ?",
                (tenant_id, user_id),
            ).fetchone()
            return Membership.from_row(row) if row else None

    def list_for_tenant(self, tenant_id: str) -> list[Membership]:
        with read_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM memberships WHERE tenant_id = ? ORDER BY role, user_id",
                (tenant_id,),
            ).fetchall()
            return [Membership.from_row(r) for r in rows]

    def upsert(self, tenant_id: str, user_id: str, role: str) -> None:
        with transaction() as conn:
            conn.execute(
                "INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?) "
                "ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role",
                (tenant_id, user_id, role),
            )

    def delete(self, tenant_id: str, user_id: str) -> bool:
        with transaction() as conn:
            return conn.execute(
                "DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?",
                (tenant_id, user_id),
            ).rowcount > 0

    def count_owners(self, tenant_id: str) -> int:
        with read_connection() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM memberships WHERE tenant_id = ? AND role = 'owner'",
                (tenant_id,),
            ).fetchone()[0]
