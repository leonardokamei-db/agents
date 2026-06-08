"""Vector store for FAQ / document chunks using sqlite-vec.

The whole RAG pipeline lives in a single SQLite file (rag.db, next to this module)
— no external vector DB, no services, no Docker. Each tenant has its own isolated
set of chunks, embedded locally with sentence-transformers ("all-MiniLM-L6-v2",
384-dim), so embeddings are free and require no API calls.

  INGEST:  PDF / raw text -> extract -> chunk (overlapping) -> embed -> store.
  QUERY:   text -> embed -> KNN search -> top-K most similar chunks.

Vectors are L2-normalized at encode time, so the L2 distance used by sqlite-vec is
monotonic with cosine similarity — ordering by ascending distance == most similar
first.

Every function here is synchronous and blocking (model inference + SQLite I/O).
Async callers (the FastAPI server, the FAQAgent) offload them with
`asyncio.to_thread`, matching the concurrency pattern used elsewhere in the app.
"""

import logging
import os
import re
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import sqlite_vec

if TYPE_CHECKING:  # heavy import (sentence-transformers -> torch) deferred to runtime
    from sentence_transformers import SentenceTransformer

log = logging.getLogger("blip-agent.rag")

EMBEDDING_MODEL = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384       # output dimension of all-MiniLM-L6-v2
CHUNK_SIZE = 500          # approx tokens per chunk (chars / 4 proxy)
CHUNK_OVERLAP = 50        # approx tokens of overlap between consecutive chunks
TOP_K = 5                 # chunks retrieved per query (higher recall — the
                          # embedding model is weak on PT, so over-retrieve and
                          # let the LLM pick the relevant chunk from the set)

# Single-file store (mirrors database.py's products.db). Honors DB_DIR so it can
# live on a Railway volume; otherwise sits next to this module, independent of the
# process working directory.
_DB_DIR = Path(os.getenv("DB_DIR") or Path(__file__).parent)
_DB_DIR.mkdir(parents=True, exist_ok=True)
DEFAULT_DB_PATH = str(_DB_DIR / "rag.db")

_model: "SentenceTransformer | None" = None


def get_embedding_model() -> "SentenceTransformer":
    """Lazily load the embedding model once.

    The sentence-transformers/torch import happens here (not at module import) and
    the first call downloads the ~80MB model. Deferring it means a missing or broken
    torch install only breaks embedding calls — the app still imports and starts.
    """
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        log.info("Loading embedding model %s ...", EMBEDDING_MODEL)
        _model = SentenceTransformer(EMBEDDING_MODEL)
    return _model


def get_vec_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Open a connection with the sqlite-vec extension loaded."""
    conn = sqlite3.connect(db_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def init_rag_db(db_path: str = DEFAULT_DB_PATH) -> None:
    """Create the chunk + embedding tables if they don't exist (idempotent)."""
    conn = get_vec_connection(db_path)
    try:
        conn.executescript(f"""
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,
                source_name TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding FLOAT[{EMBEDDING_DIM}]
            );
        """)
        conn.commit()
    finally:
        conn.close()


def split_text_into_chunks(text: str, chunk_size: int = CHUNK_SIZE,
                           overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Chunk text along detected section titles, one chunk per section.

    This keeps each topic in its own chunk so retrieval returns a focused,
    self-contained passage instead of a window that straddles two unrelated
    sections. When the text has no usable structure it defers entirely to the
    size-based fallback (:func:`_chunk_by_size`).

    A line is treated as a section title when ALL of these hold:
      * it is 4-60 characters long and contains no digits (dates, prices and
        hours belong to body text, not headings),
      * it does not end with '.', ',' or ';',
      * it starts a new block: the document start, a blank line, OR right after a
        line that ends a sentence ('.', '!' or '?'). PDF extraction usually drops
        the blank line before a heading, so this "after a sentence" case is what
        lets real PDFs chunk by section instead of falling back to size,
      * its body (the next non-empty line) is longer than the heading, and
      * it is not a sentence fragment (starts uppercase, or is ALL CAPS).

    Flow:
      1. Find the title lines; fewer than 2 -> defer to _chunk_by_size.
      2. Slice into one raw section per title (any text before the first title
         becomes an untitled preamble section).
      3. Per section: a section larger than chunk_size*4 chars is size-chunked
         with its title prepended to every sub-chunk; two *adjacent very short*
         sections are merged (the only case where sections share a chunk);
         every other section becomes its own chunk.
      4. Drop chunks shorter than 50 chars and return the rest.

    chunk_size / overlap are in approximate tokens (chars / 4); overlap is only
    used by the size-based fallback.
    """
    char_size = chunk_size * 4
    very_short = char_size // 20  # ~25 tokens; below this a section is a stray fragment

    lines = re.split(r"\r\n|\r|\n", text)
    last_content = max((i for i, ln in enumerate(lines) if ln.strip()), default=-1)

    def _is_title(i: int) -> bool:
        line = lines[i].strip()
        if not (4 <= len(line) <= 60):
            return False
        if line[-1] in ".,;":
            return False
        if any(c.isdigit() for c in line):
            return False  # dates/prices/hours are body text, not section headings
        if i >= last_content:
            return False  # no body below it
        # Must start a new block: doc start, a blank line, or just after a line
        # that ends a sentence (PDF extraction tends to drop the blank line).
        if i != 0:
            prev = lines[i - 1].strip()
            if prev and not prev.endswith((".", "!", "?")):
                return False
        # Body under the heading should be longer than the heading itself — guards
        # against treating a short stray line as a section title.
        nxt = next((lines[j].strip() for j in range(i + 1, len(lines)) if lines[j].strip()), "")
        if len(nxt) <= len(line):
            return False
        # Reject sentence fragments: a heading starts uppercase or is ALL CAPS.
        return line[0].isupper() or (line.upper() == line and any(c.isalpha() for c in line))

    title_indices = [i for i in range(len(lines)) if _is_title(i)]
    if len(title_indices) < 2:
        return _chunk_by_size(text, chunk_size, overlap)

    # Section boundaries: text before the first title is an untitled preamble.
    bounds = title_indices[:]
    if bounds[0] != 0:
        bounds.insert(0, 0)
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
            # Oversized section: flush, then size-chunk it, keeping the title on
            # every sub-chunk so each one still carries its topic.
            if buffer:
                chunks.append(buffer)
                buffer = ""
            for sub in _chunk_by_size(section, chunk_size, overlap):
                if title and not sub.lstrip().startswith(title):
                    chunks.append(f"{title}\n\n{sub}")
                else:
                    chunks.append(sub)
        elif buffer and len(buffer) < very_short and len(section) < very_short:
            # The "unless they are both very short" exception: only stray, tiny
            # sections ever merge; normal sections never share a chunk.
            buffer = f"{buffer}\n\n{section}"
        else:
            if buffer:
                chunks.append(buffer)
            buffer = section
    if buffer:
        chunks.append(buffer)

    return [c.strip() for c in chunks if len(c.strip()) > 50]


def _chunk_by_size(text: str, chunk_size: int = CHUNK_SIZE,
                   overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Size-based fallback chunking with sentence-boundary snapping and overlap.

    Slides a window of chunk_size*4 chars across `text`, stepping by
    (chunk_size - overlap)*4 chars so consecutive chunks overlap. Before each
    cut it snaps back to the last '. ' in the window's second half, so chunks
    end on a sentence boundary where possible. Chunks shorter than 50 chars are
    dropped. Sizes are in approximate tokens (chars / 4).
    """
    char_size = chunk_size * 4
    char_overlap = overlap * 4
    chunks = []
    start = 0
    while start < len(text):
        end = start + char_size
        chunk = text[start:end]
        # Prefer to break at a sentence boundary in the back half of the window.
        if end < len(text):
            last_period = chunk.rfind(". ")
            if last_period > char_size // 2:
                chunk = chunk[:last_period + 1]
                end = start + last_period + 1
        chunks.append(chunk.strip())
        start = end - char_overlap
    return [c for c in chunks if len(c) > 50]


def _delete_existing(conn: sqlite3.Connection, tenant_id: str, source_name: str) -> int:
    """Delete all chunks (and their embeddings) for a tenant+source. No commit.

    Returns the number of chunk rows removed. Used both by re-ingest (replace) and
    by delete_source.
    """
    existing_ids = [
        row[0] for row in conn.execute(
            "SELECT id FROM chunks WHERE tenant_id=? AND source_name=?",
            (tenant_id, source_name),
        ).fetchall()
    ]
    if existing_ids:
        placeholders = ",".join("?" * len(existing_ids))
        conn.execute(
            f"DELETE FROM chunk_embeddings WHERE chunk_id IN ({placeholders})",
            existing_ids,
        )
        conn.execute(
            "DELETE FROM chunks WHERE tenant_id=? AND source_name=?",
            (tenant_id, source_name),
        )
    return len(existing_ids)


def _embed_and_store(conn: sqlite3.Connection, tenant_id: str, source_name: str,
                     chunks: list[str]) -> None:
    """Embed `chunks` and insert them + their vectors into the DB. No commit."""
    model = get_embedding_model()
    embeddings = model.encode(chunks, show_progress_bar=False, normalize_embeddings=True)
    for i, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
        cursor = conn.execute(
            "INSERT INTO chunks (tenant_id, source_name, chunk_index, content) "
            "VALUES (?, ?, ?, ?)",
            (tenant_id, source_name, i, chunk),
        )
        conn.execute(
            "INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)",
            (cursor.lastrowid, embedding.astype(np.float32).tobytes()),
        )


def _ingest(tenant_id: str, text: str, source_name: str, db_path: str) -> dict:
    """Shared ingest core: chunk -> replace existing -> embed -> store."""
    chunks = split_text_into_chunks(text)
    if not chunks:
        raise ValueError("O texto fornecido é curto demais para gerar chunks.")

    conn = get_vec_connection(db_path)
    try:
        _delete_existing(conn, tenant_id, source_name)  # re-ingest replaces
        _embed_and_store(conn, tenant_id, source_name, chunks)
        conn.commit()
    finally:
        conn.close()

    log.info("Ingested %d chunks (tenant=%s, source=%s)", len(chunks), tenant_id, source_name)
    return {"chunks_created": len(chunks), "source_name": source_name, "tenant_id": tenant_id}


def _strip_repeated_page_lines(pages: list[str]) -> str:
    """Join PDF pages, dropping headers/footers that repeat across pages.

    PDF text extraction emits the running header/footer (brand name, page number,
    document title) on every page. Concatenating the pages then injects those
    lines into the middle of the body — often splitting a word or sentence across
    the page boundary — which wrecks both chunking and embeddings. We drop any
    short line that shows up on at least half the pages. Each kept line is also
    stripped of its extraction indentation. Falls back to a plain join for short
    documents (< 3 pages), where there's no reliable repetition signal.
    """
    from collections import Counter

    page_lines = [[ln.strip() for ln in p.splitlines()] for p in pages]
    if len(page_lines) < 3:
        return "\n\n".join("\n".join(lines) for lines in page_lines).strip()

    counts: "Counter[str]" = Counter()
    for lines in page_lines:
        for ln in {ln for ln in lines if ln}:  # count each line once per page
            counts[ln] += 1
    threshold = max(2, len(page_lines) // 2)
    repeated = {ln for ln, c in counts.items() if c >= threshold and len(ln) <= 60}

    cleaned = ["\n".join(ln for ln in lines if ln not in repeated) for lines in page_lines]
    return "\n\n".join(cleaned).strip()


def ingest_pdf(tenant_id: str, pdf_path: str, source_name: str,
               db_path: str = DEFAULT_DB_PATH) -> dict:
    """Extract text from a PDF, chunk it, embed each chunk, store in the vector DB.

    Repeated headers/footers are stripped before chunking (see
    :func:`_strip_repeated_page_lines`). Re-ingesting the same (tenant,
    source_name) replaces the previous chunks. Returns {chunks_created,
    source_name, tenant_id}.
    """
    from pypdf import PdfReader

    reader = PdfReader(pdf_path)
    full_text = _strip_repeated_page_lines([page.extract_text() or "" for page in reader.pages])
    if not full_text:
        raise ValueError(f"Não foi possível extrair texto de {pdf_path}.")
    return _ingest(tenant_id, full_text, source_name, db_path)


def ingest_text(tenant_id: str, text: str, source_name: str,
                db_path: str = DEFAULT_DB_PATH) -> dict:
    """Same as ingest_pdf but accepts raw text. Useful for seeding / testing."""
    return _ingest(tenant_id, text, source_name, db_path)


def search_chunks(tenant_id: str, query: str, top_k: int = TOP_K,
                  db_path: str = DEFAULT_DB_PATH) -> list[dict]:
    """Embed the query and return the top_k most similar chunks for this tenant.

    Returns a list of {content, source_name, chunk_index, score}. `score` is the L2
    distance (lower == more similar). The KNN runs over the whole store, so we
    over-fetch (top_k * 3) and keep the closest top_k that belong to this tenant.
    """
    model = get_embedding_model()
    query_embedding = model.encode([query], normalize_embeddings=True)[0]

    conn = get_vec_connection(db_path)
    try:
        rows = conn.execute(
            """
            SELECT c.content, c.source_name, c.chunk_index, ce.distance
            FROM chunk_embeddings ce
            JOIN chunks c ON c.id = ce.chunk_id
            WHERE c.tenant_id = ?
              AND ce.embedding MATCH ?
              AND k = ?
            ORDER BY ce.distance
            """,
            (tenant_id, query_embedding.astype(np.float32).tobytes(), top_k * 3),
        ).fetchall()
    finally:
        conn.close()

    return [
        {"content": r[0], "source_name": r[1], "chunk_index": r[2], "score": float(r[3])}
        for r in rows[:top_k]
    ]


def list_sources(tenant_id: str, db_path: str = DEFAULT_DB_PATH) -> list[dict]:
    """List all ingested sources for a tenant with chunk counts and last update."""
    conn = get_vec_connection(db_path)
    try:
        rows = conn.execute(
            """
            SELECT source_name, COUNT(*) AS chunk_count, MAX(created_at) AS last_updated
            FROM chunks
            WHERE tenant_id = ?
            GROUP BY source_name
            ORDER BY last_updated DESC
            """,
            (tenant_id,),
        ).fetchall()
    finally:
        conn.close()
    return [{"source_name": r[0], "chunk_count": r[1], "last_updated": r[2]} for r in rows]


def delete_source(tenant_id: str, source_name: str, db_path: str = DEFAULT_DB_PATH) -> dict:
    """Delete all chunks for a given (tenant, source)."""
    conn = get_vec_connection(db_path)
    try:
        deleted = _delete_existing(conn, tenant_id, source_name)
        conn.commit()
    finally:
        conn.close()
    return {"deleted_chunks": deleted, "source_name": source_name}


if __name__ == "__main__":
    sample = """
Horario de funcionamento

A loja atende de segunda a sexta das 9h as 18h e aos sabados das 10h as 14h.
O atendimento online funciona de segunda a sexta das 8h as 20h.

Formas de pagamento

Aceitamos Visa, Mastercard, Elo e American Express em ate 12x sem juros.
Pagamentos via PIX tem 5 por cento de desconto automatico.
Boleto bancario disponivel com vencimento em 3 dias uteis.

Prazo de entrega

Para capitais: 2 a 4 dias uteis.
Para interior: 5 a 10 dias uteis.
Para Norte e Nordeste: 7 a 15 dias uteis.
"""
    chunks = split_text_into_chunks(sample)
    print(f"Chunks gerados: {len(chunks)}")
    for i, c in enumerate(chunks):
        print(f"\n--- Chunk {i+1} ({len(c)} chars) ---")
        print(c)

    assert len(chunks) == 3, f"Esperado 3 chunks (1 por secao), obtido {len(chunks)}"
    assert "Horario" in chunks[0]
    assert "pagamento" in chunks[1]
    assert "entrega" in chunks[2]
    print("\nTodos os asserts passaram.")
