-- ============================================================================
-- blip-agent — seed OPCIONAL (tenant default + agente demo + produtos)
-- Rode no SQL Editor do Supabase DEPOIS do schema.sql. Idempotente.
--
-- Alternativa: NÃO rode este arquivo e deixe a app semear no 1º boot do Railway
-- (`npm run db:seed`), que gera e LOGA a api_key do tenant default uma vez.
--
-- IMPORTANTE: troque a api_key abaixo por uma chave forte sua. É a "chave do
-- tenant" (consumo/chat). Guarde-a — é o que o painel/integradores usam.
-- ============================================================================

insert into tenants (id, name, api_key)
values ('default', 'Default', 'TROQUE-ESTA-CHAVE-blip-tenant-coloque-um-segredo-forte')
on conflict (id) do nothing;

insert into agents (
    id, tenant_id, slug, name, system_prompt, business_rules, max_turns,
    product_mode, product_api_url, product_api_key, rag_enabled, external_products, skills
) values (
    'default__demo', 'default', 'demo', 'Loja Demo', '',
    'Troca em até 7 dias com nota fiscal. Reembolso se a entrega atrasar mais de 7 dias. Para defeitos, oriente sobre a garantia antes de escalar.',
    15, 'internal', '', '', true, true, '[]'::jsonb
)
on conflict (tenant_id, slug) do nothing;

-- Produtos demo (só insere se o agente ainda não tiver produtos).
insert into products (agent_id, name, description, price, stock, unit)
select v.agent_id, v.name, v.description, v.price, v.stock, v.unit
from (values
    ('default__demo', 'Smartphone Galaxy A55', 'Smartphone 5G, 256GB, tela AMOLED 6.6"', 1899.90, 12, 'unidade'),
    ('default__demo', 'Notebook Ideapad 3', 'Notebook 15.6", Ryzen 5, 8GB RAM, SSD 512GB', 3299.00, 5, 'unidade'),
    ('default__demo', 'Fone Bluetooth JBL Tune', 'Fone over-ear sem fio, bateria 40h', 299.90, 2, 'unidade'),
    ('default__demo', 'Smart TV 50" 4K', 'Smart TV LED 50 polegadas, 4K, Wi-Fi', 2499.00, 0, 'unidade'),
    ('default__demo', 'Mouse Gamer RGB', 'Mouse óptico 7200 DPI com iluminação RGB', 149.90, 30, 'unidade')
) as v(agent_id, name, description, price, stock, unit)
where not exists (select 1 from products where agent_id = 'default__demo');
