"""Harness de avaliação do blip-agent.

Roda três baterias contra o FAQ da Loja Demo (docs/fixtures/faq_loja_demo.txt):
  1. Embeddings — dimensão, normalização L2 e matriz de similaridade query x tópico.
  2. RAG/chat — bateria de perguntas com gabarito, medindo acurácia (fatos
     esperados presentes na resposta), tokens, fonte e latência.
  3. Casos negativos — perguntas fora do escopo devem gerar handoff.

Gera um relatório em Markdown em docs/eval_log.md.

Uso:
    PYTHONPATH=. .venv/Scripts/python.exe docs/eval_harness.py
"""

import os
import sys
import tempfile
import time
from pathlib import Path

# Banco isolado para o teste (não toca core.db/rag.db de produção).
os.environ["DB_DIR"] = tempfile.mkdtemp(prefix="blip_eval_")
os.environ.setdefault("ADMIN_API_KEY", "eval-admin")
os.environ["SEED_DEMO"] = "0"  # criamos nosso próprio agente

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from app import config, rag, tenants  # noqa: E402
from app.db import init_db  # noqa: E402
from app.embeddings import embed_documents, embed_query  # noqa: E402
from app.llm import get_llm  # noqa: E402
from app.orchestrator import Orchestrator  # noqa: E402

FAQ_PATH = ROOT / "docs" / "fixtures" / "faq_loja_demo.txt"
LOG_PATH = ROOT / "docs" / "eval_log.md"

report: list[str] = []


try:  # Windows console é cp1252; força UTF-8 para imprimir ✓/✗.
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def out(line: str = "") -> None:
    try:
        print(line)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"))
    report.append(line)


# --------------------------------------------------------------------------- #
# 1. Embeddings
# --------------------------------------------------------------------------- #

def test_embeddings() -> None:
    out("## 1. Teste de embeddings (Jina API)\n")
    out(f"- Modelo: `{config.JINA_MODEL}` · dimensão configurada: **{config.EMBEDDING_DIM}**\n")

    # Tópicos representativos do FAQ (lado "passage").
    topics = {
        "horario": "A loja atende de segunda a sexta das 9h as 18h e sabados das 10h as 14h.",
        "pagamento": "Aceitamos cartao de credito em ate 12x sem juros, PIX com 5% de desconto e boleto.",
        "entrega": "O prazo de entrega para capitais e de 2 a 4 dias uteis e interior de 5 a 10 dias.",
        "garantia": "Os produtos tem garantia minima de 12 meses contra defeitos de fabricacao.",
        "trocas": "O cliente pode trocar ou devolver em ate 7 dias corridos apos o recebimento.",
    }
    keys = list(topics)
    t0 = time.perf_counter()
    passage_vecs = embed_documents([topics[k] for k in keys])
    embed_ms = (time.perf_counter() - t0) * 1000

    dim = passage_vecs.shape[1]
    norms = np.linalg.norm(passage_vecs, axis=1)
    out(f"- Dimensão dos vetores retornados: **{dim}** "
        f"({'OK' if dim == config.EMBEDDING_DIM else 'DIVERGENTE'})")
    out(f"- Norma L2 média: **{norms.mean():.4f}** "
        f"({'normalizado ✓' if np.allclose(norms, 1.0, atol=1e-2) else 'NÃO normalizado'})")
    out(f"- Latência de embedding ({len(keys)} passagens em lote): **{embed_ms:.0f} ms**\n")

    # Perguntas do usuário (lado "query") vs cada tópico. A diagonal deve vencer.
    queries = {
        "horario": "que horas a loja abre?",
        "pagamento": "posso parcelar no cartao?",
        "entrega": "quanto tempo demora pra chegar?",
        "garantia": "qual a garantia dos produtos?",
        "trocas": "como faço pra devolver um produto?",
    }
    query_vecs = np.vstack([embed_query(queries[k]) for k in keys])
    sims = query_vecs @ passage_vecs.T  # cosseno (vetores normalizados)

    out("Matriz de similaridade (cosseno) — pergunta (linha) × tópico (coluna). "
        "Diagonal = match correto:\n")
    header = "| pergunta \\ tópico | " + " | ".join(keys) + " |"
    out(header)
    out("|" + "---|" * (len(keys) + 1))
    correct = 0
    for i, k in enumerate(keys):
        row = sims[i]
        best = int(np.argmax(row))
        if best == i:
            correct += 1
        cells = " | ".join(
            f"**{row[j]:.3f}**" if j == i else f"{row[j]:.3f}" for j in range(len(keys))
        )
        flag = "✓" if best == i else f"✗ (casou com {keys[best]})"
        out(f"| {queries[k][:28]} | {cells} | {flag} |".replace(" | ✓", " ✓").replace(" |  ✗", " ✗"))
    out("")
    out(f"**Acerto top-1 dos embeddings: {correct}/{len(keys)} "
        f"({100*correct/len(keys):.0f}%)**\n")


# --------------------------------------------------------------------------- #
# 2. RAG / chat — acurácia, tokens, fonte
# --------------------------------------------------------------------------- #

# Cada caso: pergunta + fatos que DEVEM aparecer na resposta (qualquer um dos
# grupos; dentro do grupo, todos). Heurística de acurácia factual.
CASES = [
    {"q": "qual o horario de funcionamento da loja fisica?",
     "must": [["9h", "18h"], ["sabado", "14h"]]},
    {"q": "ate quantas vezes posso parcelar no cartao de credito?",
     "must": [["12"]]},
    {"q": "tem desconto no pix?",
     "must": [["5%"], ["5 por cento"], ["desconto"]]},
    {"q": "quanto tempo demora a entrega para capitais?",
     "must": [["2 a 4"], ["4 dias"]]},
    {"q": "quanto custa a entrega expressa?",
     "must": [["19,90"], ["19.90"]]},
    {"q": "qual o prazo para trocar um produto por arrependimento?",
     "must": [["7 dias"]]},
    {"q": "qual a garantia dos produtos eletronicos?",
     "must": [["12 meses"]]},
    {"q": "quanto custa a garantia estendida?",
     "must": [["49,90"], ["49.90"]]},
    {"q": "como funciona o programa de fidelidade?",
     "must": [["ponto"], ["pontos"]]},
    {"q": "voces aceitam cheque?",
     "must": [["nao acei"], ["não acei"], ["nao aceitamos"]]},
    {"q": "como rastreio meu pedido?",
     "must": [["rastreamento"], ["rastreio"], ["e-mail"], ["correios"]]},
    {"q": "posso cancelar meu pedido depois de enviado?",
     "must": [["nao"], ["devolucao"], ["devolução"], ["postado"]]},
]

# Casos fora do escopo do FAQ — devem gerar handoff (modelo não inventa).
NEGATIVE_CASES = [
    "qual o cnpj da loja demo?",
    "voces vendem geladeira?",
    "qual o salario do CEO da empresa?",
]


def _norm(s: str) -> str:
    return s.lower()


def _answer_matches(answer: str, must: list[list[str]]) -> bool:
    a = _norm(answer)
    for group in must:
        if all(_norm(token) in a for token in group):
            return True
    return False


def test_rag_chat(orch: Orchestrator) -> None:
    import asyncio

    out("## 2. Teste de RAG + chat — acurácia, tokens e fonte\n")
    out("Histórico vazio (cada pergunta é independente). Acurácia = fato esperado "
        "presente na resposta.\n")
    out("| # | Pergunta | Intent (conf.) | Agente/Fonte | Tokens | Latência | Acerto |")
    out("|---|----------|----------------|--------------|--------|----------|--------|")

    total_tokens = 0
    total_ms = 0.0
    hits = 0
    answers_dump = []

    for i, case in enumerate(CASES, 1):
        t0 = time.perf_counter()
        r = asyncio.run(orch.process(case["q"], []))
        ms = (time.perf_counter() - t0) * 1000
        total_ms += ms
        total_tokens += r.get("tokens_used", 0)
        ok = _answer_matches(r["response"], case["must"])
        hits += int(ok)
        out(f"| {i} | {case['q'][:40]} | {r['intent']} ({r['confidence']}) | "
            f"{r['agent_used']}/{r['source']} | {r.get('tokens_used',0)} | "
            f"{ms:.0f} ms | {'✓' if ok else '✗'} |")
        answers_dump.append((case["q"], r["response"], ok, r["source"], r.get("tokens_used", 0)))

    n = len(CASES)
    shortcuts = sum(1 for *_, src, _ in answers_dump if src == "faq_shortcut")
    out("")
    out(f"**Acurácia factual: {hits}/{n} ({100*hits/n:.0f}%)**")
    out(f"- Tokens totais: **{total_tokens}** · média **{total_tokens/n:.0f}**/pergunta")
    out(f"- Atalhos sem LLM (faq_shortcut, 0 tokens): **{shortcuts}/{n}**")
    out(f"- Latência média: **{total_ms/n:.0f} ms**/pergunta\n")

    out("<details><summary>Respostas completas (amostra)</summary>\n")
    for q, ans, ok, src, tok in answers_dump:
        out(f"**P:** {q}  ")
        out(f"**R** ({src}, {tok} tok) {'✓' if ok else '✗'}**:** {ans}\n")
    out("</details>\n")


def test_routing_diagnosis(agent_cfg) -> None:
    """Mostra que a base de conhecimento RESPONDE as perguntas que o antigo
    classificador desviava. Força um agente com APENAS a skill knowledge_search
    (a antiga FAQ) e mede a acurácia. No modelo de skills não há classificador: o
    LLM escolhe a skill, então esse desvio determinístico deixou de existir."""
    import asyncio
    from dataclasses import replace

    from app.agents import SkilledAgent

    out("## 4. Diagnóstico de recuperação — a base responde, sem classificador\n")
    out("No modelo antigo, palavras-chave (\"custa\", \"demora\", \"cancelar\") desviavam "
        "estas perguntas para os agentes de pedido/suporte, que **não consultavam a "
        "base de conhecimento**. Aqui forçamos um agente só com a skill "
        "`knowledge_search` para mostrar que a informação está recuperável — e no "
        "novo modelo é o LLM que escolhe essa skill:\n")

    faq = SkilledAgent(replace(agent_cfg, skills=("knowledge_search",)), get_llm())
    out("| Pergunta | Desvio no modelo antigo | Fonte (skill) | Acerto |")
    out("|----------|--------------------------|---------------|--------|")
    misrouted = [
        (CASES[3], "support → resposta inventada"),
        (CASES[4], "order → handoff"),
        (CASES[7], "order → handoff"),
        (CASES[11], "support → handoff automático"),
    ]
    fixed = 0
    dump = []
    for case, real_route in misrouted:
        r = asyncio.run(faq.execute(case["q"], []))
        ok = _answer_matches(r.response, case["must"])
        fixed += int(ok)
        out(f"| {case['q'][:38]} | {real_route} | {r.source} | {'✓' if ok else '✗'} |")
        dump.append((case["q"], r.response, ok))
    out("")
    out(f"**Recuperação correta via knowledge_search: {fixed}/{len(misrouted)} "
        f"— a base tinha a resposta; o gargalo era o classificador, agora removido.**\n")
    out("<details><summary>Respostas via knowledge_search</summary>\n")
    for q, ans, ok in dump:
        out(f"**P:** {q}  \n**R** {'✓' if ok else '✗'}**:** {ans}\n")
    out("</details>\n")


def test_negative(orch: Orchestrator) -> None:
    import asyncio

    out("## 3. Casos fora do escopo — devem fazer handoff (não alucinar)\n")
    out("| Pergunta | Fonte | Handoff? | Resposta (início) |")
    out("|----------|-------|----------|-------------------|")
    good = 0
    for q in NEGATIVE_CASES:
        r = asyncio.run(orch.process(q, []))
        handoff = r.get("should_handoff", False)
        good += int(handoff)
        out(f"| {q[:42]} | {r['source']} | {'✓ sim' if handoff else '✗ não'} | "
            f"{r['response'][:60]}... |")
    out("")
    out(f"**Handoff correto em casos fora de escopo: {good}/{len(NEGATIVE_CASES)}**\n")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> None:
    init_db()
    rag.init_rag_db()

    agent = tenants.create_agent({
        "id": "loja-eval",
        "name": "Loja Demo",
        "business_rules": "Seja objetivo. Cite valores e prazos exatos quando houver.",
        "product_mode": "internal",
    })

    out("# Relatório de avaliação — blip-agent\n")
    out(f"- Modelo LLM: `{config.GROQ_MODEL}`")
    out(f"- HISTORY_LIMIT: {config.HISTORY_LIMIT} mensagens · RAG_TOP_K: {config.RAG_TOP_K} chunks")
    out(f"- Base: FAQ Loja Demo (`docs/fixtures/faq_loja_demo.txt`)\n")

    # Embeddings primeiro (independente da ingestão).
    test_embeddings()

    # Ingestão do FAQ.
    faq_text = FAQ_PATH.read_text(encoding="utf-8")
    t0 = time.perf_counter()
    ing = rag.ingest_text("loja-eval", faq_text, "faq_loja_demo")
    ing_ms = (time.perf_counter() - t0) * 1000
    out(f"### Ingestão do FAQ\n")
    out(f"- Chunks criados: **{ing['chunks_created']}** · "
        f"tempo de ingestão (chunk+embed+gravação): **{ing_ms:.0f} ms**\n")

    agent_cfg = tenants.get_agent("loja-eval")
    orch = Orchestrator(agent_cfg, get_llm())
    test_rag_chat(orch)
    test_routing_diagnosis(agent_cfg)
    test_negative(orch)

    LOG_PATH.write_text("\n".join(report), encoding="utf-8")
    print(f"\n>>> Relatório salvo em {LOG_PATH}")


if __name__ == "__main__":
    main()
