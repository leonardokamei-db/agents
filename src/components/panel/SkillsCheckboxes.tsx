"use client";

import type { SkillCatalogItem } from "./types";

/** Fallback só-nomes quando o catálogo de skills (com descrições) não carregou. */
const SKILLS_LIST = [
  "knowledge_search",
  "check_stock",
  "search_products",
  "list_products",
  "reserve_stock",
  "check_catalog",
  "escalate_to_human",
  "create_ticket",
];

export function SkillsCheckboxes({ active, catalog }: { active?: string[]; catalog?: SkillCatalogItem[] }) {
  const items: SkillCatalogItem[] =
    catalog && catalog.length > 0
      ? catalog
      : SKILLS_LIST.map((name) => ({ name, description: "", category: "", always_on: false, requires: null }));
  return (
    <div className="skills-list">
      {items.map((s) => (
        <label key={s.name} className="skill-item">
          <input
            type="checkbox"
            name="skills"
            value={s.name}
            defaultChecked={active ? active.includes(s.name) : false}
          />
          <div className="skill-body">
            <div className="skill-name">
              <code>{s.name}</code>
              {s.requires === "rag" && <span className="req">requer RAG</span>}
              {s.requires === "catalog" && <span className="req">requer catálogo</span>}
            </div>
            {s.description && <div className="skill-desc">{s.description}</div>}
          </div>
        </label>
      ))}
    </div>
  );
}
