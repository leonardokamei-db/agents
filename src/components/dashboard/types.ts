/**
 * Tipos wire do dashboard de dados (formato devolvido por GET .../analytics).
 */

export interface Summary {
  total: number;
  handoff_count: number;
  success_no_handoff: number;
  handoff_rate: number;
  success_rate: number;
  tokens_total: number;
  tokens_avg: number;
}
export interface DayPoint {
  day: string;
  count: number;
  handoffs: number;
  tokens: number;
}
export interface LabelCount {
  label: string;
  count: number;
}
export interface AgentRow {
  slug: string;
  agent_id: string;
  count: number;
  handoffs: number;
  tokens: number;
}
export interface RecentRow {
  id: number;
  slug: string;
  intent: string;
  source: string;
  agent_used: string;
  tokens_used: number;
  should_handoff: boolean;
  handoff_reason: string;
  tools_called: string[];
  rag_chunks_used: number;
  created_at: string;
}
export interface Dashboard {
  range: { days: number; since: string; agent_slug: string | null };
  summary: Summary;
  by_day: DayPoint[];
  by_intent: LabelCount[];
  by_source: LabelCount[];
  by_agent: AgentRow[];
  top_tools: LabelCount[];
  recent: RecentRow[];
}
export interface AgentLite {
  slug: string;
  name: string;
}
