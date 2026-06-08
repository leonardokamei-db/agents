"""
Compare token usage and response quality between old (no classifier) and new (with classifier) versions.

Usage:
  1. Start the old server: uvicorn server_old:app --port 8001
  2. Start the new server: uvicorn server:app --port 8000
  3. Run this script: python test_comparison.py
"""

import asyncio
import json
from dataclasses import dataclass

import httpx

OLD_API = "http://localhost:8001/v1/chat"
NEW_API = "http://localhost:8000/v1/chat"

TENANT = "loja_demo"
API_KEY = "key-loja-123"

HEADERS = {"X-API-Key": API_KEY, "Content-Type": "application/json"}

# Test prompts
PROMPTS = [
    # FAQ (expected: shortcut, 0 tokens)
    ("1. FAQ: Horário de funcionamento", "Qual é o horário de funcionamento da loja?"),
    ("2. FAQ: Política de troca", "Como funciona a política de troca?"),
    ("3. FAQ: Formas de pagamento", "Quais formas de pagamento aceitam?"),
    # Clarification (expected: new version asks clarifying question)
    ("4. Clarif: Ambíguo genérico", "Oi, tudo bem?"),
    ("5. Clarif: Ambíguo vago", "Vocês são bons?"),
    ("6. Clarif: Ambíguo incompreensão", "Não entendi"),
    # Support (expected: new version escalates faster)
    ("7. Support: Atraso de entrega", "Meu pedido não chegou, está atrasado há 10 dias"),
    ("8. Support: Reembolso urgente", "Quero um reembolso agora!"),
    ("9. Support: Ameaça legal", "Vou processar isso, quero um advogado!"),
    # Normal support
    ("10. Support normal: Rastreio", "Não recebi o código de rastreio do meu pedido, podem me ajudar?"),
    # FAQ + context
    ("11. FAQ + contexto: Parcelamento", "Vocês oferecem parcelamento? Preciso de até 12 vezes."),
    # Complex
    ("12. Complex: Prazo + garantia", "Quanto tempo leva pra chegar no nordeste? E tem garantia internacional?"),
]


@dataclass
class Result:
    test_name: str
    version: str
    intent: str = None
    confidence: float = None
    agent: str = None
    tokens: int = 0
    handoff: bool = False
    response_preview: str = ""
    error: str = None

    def to_dict(self):
        return {
            "test": self.test_name,
            "version": self.version,
            "intent": self.intent,
            "confidence": self.confidence,
            "agent": self.agent,
            "tokens": self.tokens,
            "handoff": self.handoff,
            "response": self.response_preview[:60] + ("..." if len(self.response_preview) > 60 else ""),
            "error": self.error,
        }


async def call_api(api_url: str, message: str, history: list = None) -> dict:
    payload = {
        "tenant_id": TENANT,
        "conversation_id": "test-conv",
        "message": message,
        "history": history or [],
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(api_url, json=payload, headers=HEADERS)
        if resp.status_code != 200:
            raise RuntimeError(f"API error {resp.status_code}: {resp.text}")
        return resp.json()


async def test_prompt(test_name: str, prompt: str):
    results = []

    # Old API
    try:
        data = await call_api(OLD_API, prompt)
        results.append(
            Result(
                test_name=test_name,
                version="OLD",
                intent=data.get("intent", "N/A"),
                confidence=data.get("confidence"),
                agent=data.get("agent_used", "N/A"),
                tokens=data.get("tokens_used", 0),
                handoff=data.get("should_handoff", False),
                response_preview=data.get("response", ""),
            )
        )
    except Exception as e:
        results.append(
            Result(
                test_name=test_name,
                version="OLD",
                error=str(e),
            )
        )

    # New API
    try:
        data = await call_api(NEW_API, prompt)
        results.append(
            Result(
                test_name=test_name,
                version="NEW",
                intent=data.get("intent", "N/A"),
                confidence=data.get("confidence"),
                agent=data.get("agent_used", "N/A"),
                tokens=data.get("tokens_used", 0),
                handoff=data.get("should_handoff", False),
                response_preview=data.get("response", ""),
            )
        )
    except Exception as e:
        results.append(
            Result(
                test_name=test_name,
                version="NEW",
                error=str(e),
            )
        )

    return results


async def main():
    print("Starting token economy comparison test...")
    print(f"Old API: {OLD_API}")
    print(f"New API: {NEW_API}")
    print()

    all_results = []

    for test_name, prompt in PROMPTS:
        print(f"Testing {test_name}... ", end="", flush=True)
        try:
            results = await test_prompt(test_name, prompt)
            all_results.extend(results)
            old_tokens = results[0].tokens if results[0].error is None else "ERR"
            new_tokens = results[1].tokens if results[1].error is None else "ERR"
            print(f"OLD={old_tokens} NEW={new_tokens}")
        except Exception as e:
            print(f"FAILED: {e}")

    # Print results as table
    print("\n" + "=" * 140)
    print("RESULTS TABLE")
    print("=" * 140)
    print(
        f"{'Test':<35} | {'Version':<5} | {'Intent':<10} | {'Conf':<6} | {'Agent':<13} | "
        f"{'Tokens':<7} | {'Handoff':<8} | {'Response Preview':<50}"
    )
    print("-" * 140)

    for result in all_results:
        print(
            f"{result.test_name:<35} | {result.version:<5} | {str(result.intent):<10} | "
            f"{str(result.confidence)[:5] if result.confidence else 'N/A':<6} | {str(result.agent):<13} | "
            f"{result.tokens:<7} | {str(result.handoff):<8} | {result.response_preview[:50]:<50}"
        )

    # Calculate savings
    print("\n" + "=" * 140)
    print("TOKEN ECONOMY ANALYSIS")
    print("=" * 140)

    savings = []
    for test_name, _ in PROMPTS:
        old = next((r for r in all_results if r.test_name == test_name and r.version == "OLD"), None)
        new = next((r for r in all_results if r.test_name == test_name and r.version == "NEW"), None)

        if old and new and old.error is None and new.error is None:
            diff = old.tokens - new.tokens
            pct = (diff / old.tokens * 100) if old.tokens > 0 else 0
            savings.append((test_name, old.tokens, new.tokens, diff, pct))
            print(
                f"{test_name:<35} | OLD: {old.tokens:>4} tokens | NEW: {new.tokens:>4} tokens | "
                f"DIFF: {diff:>4} ({pct:>+5.1f}%)"
            )

    if savings:
        avg_old = sum(s[1] for s in savings) / len(savings)
        avg_new = sum(s[2] for s in savings) / len(savings)
        avg_saving = avg_old - avg_new
        avg_pct = (avg_saving / avg_old * 100) if avg_old > 0 else 0
        print("-" * 140)
        print(
            f"{'AVERAGE':<35} | OLD: {avg_old:>7.1f} | NEW: {avg_new:>7.1f} | "
            f"DIFF: {avg_saving:>7.1f} ({avg_pct:>+5.1f}%)"
        )

    # Save to JSON
    with open("test_results.json", "w", encoding="utf-8") as f:
        json.dump([r.to_dict() for r in all_results], f, indent=2, ensure_ascii=False)
    print(f"\n✅ Results saved to test_results.json")


if __name__ == "__main__":
    asyncio.run(main())
