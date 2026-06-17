"""Vector store RAG (sqlite-vec) para FAQs/PDFs, isolado por agente.

Vive em um único arquivo SQLite (rag.db) — sem serviço externo.

  INGESTÃO: PDF / texto -> extrai -> chunking por seção -> embeda -> grava.
  CONSULTA: texto -> embeda -> KNN -> top-K chunks mais similares.

Os vetores voltam L2-normalizados da Jina, então a distância L2 do sqlite-vec
ordena por similaridade de cosseno (menor distância == mais similar).

Tudo aqui é síncrono (SQLite + HTTP bloqueante); chamadores async usam
`asyncio.to_thread`.
"""

import logging
import re
import sqlite3
from collections import Counter

import numpy as np
import sqlite_vec

from app import config
from app.embeddings import EmbeddingError, embed_documents, embed_query
from app.errors import ValidationError

log = logging.getLogger("blip-agent.rag")

_MIN_CHUNK_CHARS = 50


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.RAG_DB_PATH)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def init_rag_db() -> None:
    """Cria as tabelas de chunks e embeddings se não existirem (idempotente) e
    reconcilia a nomenclatura legada: a coluna de escopo passou de `tenant_id`
    para `agent_id` (ponto 19) — o valor segue sendo o id do agente."""
    conn = _connect()
    try:
        conn.executescript(f"""
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT NOT NULL,
                source_name TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding FLOAT[{config.EMBEDDING_DIM}]
            );
        """)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(chunks)").fetchall()}
        if "tenant_id" in cols and "agent_id" not in cols:
            conn.execute("ALTER TABLE chunks RENAME COLUMN tenant_id TO agent_id")
            log.warning("rag.db migrado: coluna chunks.tenant_id -> agent_id.")
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Chunking
# --------------------------------------------------------------------------- #

def split_text_into_chunks(text: str, chunk_size: int = config.RAG_CHUNK_SIZE,
                           overlap: int = config.RAG_CHUNK_OVERLAP) -> list[str]:
    """Divide o texto em chunks, um por seção detectada via linhas de título.

    Cada tópico fica em seu próprio chunk, então a busca devolve uma passagem
    focada. Sem estrutura detectável (< 2 títulos), cai no fallback por tamanho.

    Uma linha é título quando TODAS valem:
      * 4-60 chars, sem dígitos (datas/preços/horários são corpo, não título);
      * não termina com '.', ',' ou ';';
      * inicia um bloco: começo do doc, linha em branco antes, OU logo após uma
        linha que fecha frase ('.', '!', '?') — extração de PDF costuma comer a
        linha em branco antes do título;
      * o corpo (próxima linha não vazia) é mais longo que o título;
      * começa com maiúscula ou é toda em CAPS (rejeita fragmentos de frase).
    """
    char_size = chunk_size * 4
    very_short = char_size // 20  # abaixo disso a seção é um fragmento perdido

    lines = re.split(r"\r\n|\r|\n", text)
    last_content = max((i for i, ln in enumerate(lines) if ln.strip()), default=-1)

    def is_title(i: int) -> bool:
        line = lines[i].strip()
        if not (4 <= len(line) <= 60) or line[-1] in ".,;":
            return False
        if any(c.isdigit() for c in line) or i >= last_content:
            return False
        if i != 0:
            prev = lines[i - 1].strip()
            if prev and not prev.endswith((".", "!", "?")):
                return False
        nxt = next((lines[j].strip() for j in range(i + 1, len(lines)) if lines[j].strip()), "")
        if len(nxt) <= len(line):
            return False
        return line[0].isupper() or (line.upper() == line and any(c.isalpha() for c in line))

    title_indices = [i for i in range(len(lines)) if is_title(i)]
    if len(title_indices) < 2:
        return _chunk_by_size(text, chunk_size, overlap)

    bounds = title_indices[:]
    if bounds[0] != 0:
        bounds.insert(0, 0)  # texto antes do 1º título vira preâmbulo sem título
    bounds.append(len(lines))
    title_set = set(title_indices)

    sections: list[tuple[str, str]] = []
    for k in range(len(bounds) - 1):
        first = bounds[k]
        body = "\n".join(lines[first:bounds[k + 1]]).strip()
        if body:
            title = lines[first].strip() if first in title_set else ""
            sections.append((title, body))

    chunks: list[str] = []
    buffer = ""
    for title, section in sections:
        if len(section) > char_size:
            # Seção grande: fatia por tamanho mantendo o título em cada pedaço.
            if buffer:
                chunks.append(buffer)
                buffer = ""
            for sub in _chunk_by_size(section, chunk_size, overlap):
                chunks.append(sub if sub.lstrip().startswith(title) or not title
                              else f"{title}\n\n{sub}")
        elif buffer and len(buffer) < very_short and len(section) < very_short:
            buffer = f"{buffer}\n\n{section}"  # só fragmentos minúsculos se fundem
        else:
            if buffer:
                chunks.append(buffer)
            buffer = section
    if buffer:
        chunks.append(buffer)

    return [c.strip() for c in chunks if len(c.strip()) > _MIN_CHUNK_CHARS]


def _chunk_by_size(text: str, chunk_size: int, overlap: int) -> list[str]:
    """Fallback: janela deslizante com overlap, cortando em fim de frase."""
    char_size, char_overlap = chunk_size * 4, overlap * 4
    chunks, start = [], 0
    while start < len(text):
        end = start + char_size
        chunk = text[start:end]
        if end < len(text):
            last_period = chunk.rfind(". ")
            if last_period > char_size // 2:
                chunk = chunk[:last_period + 1]
                end = start + last_period + 1
        chunks.append(chunk.strip())
        start = end - char_overlap
    return [c for c in chunks if len(c) > _MIN_CHUNK_CHARS]


# --------------------------------------------------------------------------- #
# Ingestão
# --------------------------------------------------------------------------- #

def ingest_pdf(agent_id: str, pdf_path: str, source_name: str) -> dict:
    """Extrai texto do PDF (limpando cabeçalhos/rodapés repetidos), chunka,
    embeda e grava. Re-ingestão do mesmo source substitui os chunks antigos."""
    from pypdf import PdfReader

    reader = PdfReader(pdf_path)
    full_text = _strip_repeated_page_lines([p.extract_text() or "" for p in reader.pages])
    if not full_text:
        raise ValidationError(f"Não foi possível extrair texto de {pdf_path}.")
    return ingest_text(agent_id, full_text, source_name)


def ingest_text(agent_id: str, text: str, source_name: str) -> dict:
    """Chunka -> substitui chunks antigos do source -> embeda -> grava."""
    chunks = split_text_into_chunks(text)
    if not chunks:
        raise ValidationError("O texto fornecido é curto demais para gerar chunks.")

    embeddings = embed_documents(chunks)
    conn = _connect()
    try:
        _delete_source_rows(conn, agent_id, source_name)
        for i, (chunk, emb) in enumerate(zip(chunks, embeddings)):
            cur = conn.execute(
                "INSERT INTO chunks (agent_id, source_name, chunk_index, content) "
                "VALUES (?, ?, ?, ?)",
                (agent_id, source_name, i, chunk),
            )
            conn.execute(
                "INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)",
                (cur.lastrowid, emb.astype(np.float32).tobytes()),
            )
        conn.commit()
    finally:
        conn.close()

    log.info("Ingestão: %d chunks (agent=%s, source=%s)", len(chunks), agent_id, source_name)
    return {"chunks_created": len(chunks), "source_name": source_name, "agent_id": agent_id}


def _strip_repeated_page_lines(pages: list[str]) -> str:
    """Une as páginas do PDF removendo cabeçalho/rodapé que se repete.

    Linhas curtas presentes em >= metade das páginas são descartadas — senão
    elas caem no meio do corpo e estragam chunking e embeddings. Documentos
    com < 3 páginas não têm sinal de repetição confiável: junta direto.
    """
    page_lines = [[ln.strip() for ln in p.splitlines()] for p in pages]
    if len(page_lines) < 3:
        return "\n\n".join("\n".join(lines) for lines in page_lines).strip()

    counts: Counter = Counter()
    for lines in page_lines:
        for ln in {ln for ln in lines if ln}:
            counts[ln] += 1
    threshold = max(2, len(page_lines) // 2)
    repeated = {ln for ln, c in counts.items() if c >= threshold and len(ln) <= 60}

    cleaned = ["\n".join(ln for ln in lines if ln not in repeated) for lines in page_lines]
    return "\n\n".join(cleaned).strip()


# --------------------------------------------------------------------------- #
# Consulta e gestão de fontes
# --------------------------------------------------------------------------- #

def search_chunks(agent_id: str, query: str, top_k: int = config.RAG_TOP_K) -> list[dict]:
    """Top-K chunks mais similares à query para este agente.

    Retorna [{content, source_name, chunk_index, score}] (score = distância L2,
    menor == mais similar). O KNN roda no store todo, então over-fetch (x3) e
    filtra por tenant. Se a API de embeddings cair, retorna [] e o agente
    degrada para o prompt base."""
    try:
        query_embedding = embed_query(query)
    except EmbeddingError as e:
        log.warning("Embedding indisponível para busca RAG: %s", e)
        return []

    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT c.content, c.source_name, c.chunk_index, ce.distance
            FROM chunk_embeddings ce
            JOIN chunks c ON c.id = ce.chunk_id
            WHERE c.agent_id = ? AND ce.embedding MATCH ? AND k = ?
            ORDER BY ce.distance
            """,
            (agent_id, query_embedding.astype(np.float32).tobytes(), top_k * 3),
        ).fetchall()
    finally:
        conn.close()

    return [
        {"content": r[0], "source_name": r[1], "chunk_index": r[2], "score": float(r[3])}
        for r in rows[:top_k]
    ]


def list_sources(agent_id: str) -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT source_name, COUNT(*) AS chunk_count, MAX(created_at) AS last_updated
            FROM chunks WHERE agent_id = ?
            GROUP BY source_name ORDER BY last_updated DESC
            """,
            (agent_id,),
        ).fetchall()
    finally:
        conn.close()
    return [{"source_name": r[0], "chunk_count": r[1], "last_updated": r[2]} for r in rows]


def delete_source(agent_id: str, source_name: str) -> dict:
    conn = _connect()
    try:
        deleted = _delete_source_rows(conn, agent_id, source_name)
        conn.commit()
    finally:
        conn.close()
    return {"deleted_chunks": deleted, "source_name": source_name}


def delete_agent_data(agent_id: str) -> int:
    """Remove todos os chunks do agente (usado ao excluir o agente)."""
    conn = _connect()
    try:
        total = 0
        for src in [r["source_name"] for r in list_sources(agent_id)]:
            total += _delete_source_rows(conn, agent_id, src)
        conn.commit()
        return total
    finally:
        conn.close()


def _delete_source_rows(conn: sqlite3.Connection, agent_id: str, source_name: str) -> int:
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM chunks WHERE agent_id=? AND source_name=?",
        (agent_id, source_name),
    ).fetchall()]
    if ids:
        placeholders = ",".join("?" * len(ids))
        conn.execute(f"DELETE FROM chunk_embeddings WHERE chunk_id IN ({placeholders})", ids)
        conn.execute("DELETE FROM chunks WHERE agent_id=? AND source_name=?",
                     (agent_id, source_name))
    return len(ids)
