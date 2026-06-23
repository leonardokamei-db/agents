# Skills remotas — cada tool como uma função independente (AWS Lambda)

> **Status:** desenho de implementação aprovado para o protótipo. Hoje **todas as
> skills são `LocalSkill`** (in-process). Este documento especifica, passo a passo
> e decisão por decisão, como uma skill passa a rodar fora do processo (Lambda/HTTP)
> **sem que nenhuma outra skill, o agente ou a API sejam afetados**. É a
> materialização do que a §3 ("Caminho para serverless") e a §11 item 8 de
> [`ARQUITETURA.md`](ARQUITETURA.md) já anteviam.

Leia antes: [`ARQUITETURA.md`](ARQUITETURA.md) §3 (agente flexível + skills) e o
skill `backend` (como adicionar uma skill).

---

## 1. Objetivo

O agente já é **genérico**: existe um único `SkilledAgent` (`app/agents/skilled.py`)
que recebe um **conjunto de skills** e deixa o **LLM decidir qual chamar** (function
calling). O cliente (owner do tenant) já **escolhe quais tools acoplar** ao agente
pelo campo `AgentConfig.skills` (editável na UI; vazio ⇒ derivado das flags).

O que falta — e é o objetivo deste desenho — é a **meta de infraestrutura**:

> Colocar **cada tool em uma função independente** (estilo AWS Lambda), de modo que
> **dar deploy em uma tool não afete nenhuma outra**, nem a API principal.

Três propriedades que o desenho precisa garantir, nesta ordem de importância:

1. **Isolamento de deploy.** Redeployar a tool X não toca o código, o processo nem
   a disponibilidade da tool Y ou da API.
2. **Mesma fonte de verdade.** O schema (function calling) que o LLM vê, a seleção
   por agente e o prompt **não mudam** quando uma tool vira remota. Local e remota
   rodam **o mesmo código de negócio** — sem fork.
3. **Zero regressão.** Os atalhos de 0 token, a economia de tokens e o contrato
   "uma skill nunca derruba a request" continuam intactos.

E uma entrega concreta que prova o caminho ponta a ponta: a **nova tool
`send_email`** — sem estado, sem DB, sem RAG —, a primeira candidata natural a virar
Lambda.

---

## 2. Princípio central: remoto é só **transporte**

A peça que cresce é a **skill**, não o agente. Uma skill tem um contrato único e
**serializável de propósito** (`app/skills/base.py`):

```
nome + descrição + modelo Pydantic de args + handler  ->  SkillResult
```

A `Skill` é uma ABC. Hoje só existe a `LocalSkill` (envolve uma função Python). A
chave do desenho é uma segunda implementação, a **`RemoteSkill`**, que satisfaz **o
mesmo `invoke(ctx, args) -> SkillResult`**, mas em vez de chamar a função local,
faz um POST HTTP para a função remota.

```
                         REGISTRY (dict nome -> Skill)
                         ┌──────────────────────────────────────────┐
   tool local hoje  ───► │ "knowledge_search" : LocalSkill           │
                         │ "reserve_stock"    : LocalSkill           │
   tool promovida   ───► │ "send_email"       : RemoteSkill ──HTTP──►│──► Lambda
                         └──────────────────────────────────────────┘
                              ▲                         ▲
                              │  to_tool_schema()       │  invoke(ctx,args)
                              │  (idêntico p/ ambas)    │  (mesma assinatura)
                  o LLM e o loop do agente NÃO percebem a diferença
```

**Por que isso é o ponto inteiro:** a `RemoteSkill` **copia verbatim** `name`,
`description`, `args_model` e `category` da skill local. Logo:

- `to_tool_schema()` é **byte-a-byte igual** (deriva só de `args_model`+`name`+`description`)
  → o LLM vê exatamente a mesma tool;
- `enabled_skills_for(agent)`, `tool_schemas_for(...)`, `all_skill_names()` e
  `AgentService._check_skills` **não mudam** (a chave continua no `REGISTRY`);
- `invoke_skill(name, raw_args, ctx)` ainda **valida com o mesmo `args_model`** e só
  então chama `.invoke(...)` — o ponto de dispatch **não sabe** que foi remoto.

A única coisa que difere entre "local" e "remoto" é **qual classe está no registry
do processo da API**. Nada mais.

---

## 3. Visão geral em uma figura

```
┌─────────────────────────── API (Railway) ───────────────────────────┐
│  SkilledAgent._run_loop()  (já roda em asyncio.to_thread)            │
│      │ o LLM pede a tool "send_email"                                │
│      ▼                                                               │
│  invoke_skill("send_email", args, ctx)   app/skills/base.py         │
│      │  valida args com SendEmailArgs (Pydantic)                     │
│      ▼                                                               │
│  REGISTRY["send_email"].invoke(ctx, args)                           │
│      │                                                               │
│      ├─ LocalSkill  → chama _send_email(ctx,args) no processo  ──┐   │
│      │                                                           │   │
│      └─ RemoteSkill → _agent_to_wire(ctx.agent)  (allowlist!)    │   │
│                       + assina HMAC + requests.post(url, json)   │   │
│                          │  timeout=(3.05, 10s)                  │   │
└──────────────────────────│──────────────────────────────────────│───┘
                           │ HTTPS POST (envelope JSON assinado)   │
                           ▼                                       │
              ┌──────────────────────── Lambda "blip-skill-send-email" ┐
              │  lambda_handler(event)                                  │
              │   1. verify_signature()  → fail-closed (401 se inválido)│
              │   2. ctx = SkillContext(agent_from_wire(req["agent"]))  │
              │   3. invoke_skill(req["skill"], req["args"], ctx) ◄─────┘  (MESMO
              │        → roda app/skills/email.py::_send_email             código
              │   4. serializa SkillResult → 200 {data, handoff, ...}     de negócio)
              └─────────────────────────────────────────────────────────┘
```

Tudo entre a API e a Lambda é o **contrato de fio** da §6. Note que a Lambda chama
**o mesmo `invoke_skill`** que a API — então a validação Pydantic e o "nunca
levanta, degrada para `{error}`" acontecem dos dois lados, sem segundo caminho.

---

## 4. Decisões de implementação (decisão por decisão)

Cada decisão lista a **escolha**, as **alternativas** consideradas e o **porquê**.

### 4.1 Transporte: **Function URL (HTTPS) com `requests`**

**Escolha:** a `RemoteSkill.invoke()` faz `requests.post(url, json=envelope,
headers=..., timeout=(3.05, REMOTE_SKILL_TIMEOUT), allow_redirects=False)` para uma
**AWS Lambda Function URL**.

| Alternativa | Por que NÃO (no protótipo) |
|---|---|
| `boto3 lambda.invoke` (SigV4) | A API roda no **Railway, fora da AWS**. Exigiria credencial AWS de longa duração (`AWS_ACCESS_KEY_ID/SECRET`) embutida no Railway + dependência `boto3` + SigV4 — a **pior postura de segredo** (credencial de conta inteira num host de terceiros) para zero ganho de protótipo. |
| API Gateway | Adiciona stage/route/deployment por tool e custo por request, sem benefício nessa escala. Fica como upgrade de produção (WAF/usage plans). |

**Porquês a favor:**
- `requests` **já é dependência** (`requirements.txt`) e o shape
  `requests.post(url, json=..., headers=..., timeout=...)` é **idêntico** ao que
  `app/catalog.py::_fetch_external` já usa para o catálogo externo (linha ~158).
  **Sem dependência nova, sem boto3.**
- **Testável localmente sem AWS:** a mesma `RemoteSkill` aponta para
  `http://localhost:9000` (um shim uvicorn que expõe o `lambda_handler`). Flipar
  uma env var exercita o caminho remoto inteiro em dev/CI **sem conta AWS**. Com
  `boto3` isso exigiria LocalStack.
- **Não precisa de `to_thread` extra:** `invoke_skill` já é chamado de dentro de
  `SkilledAgent._run_loop`, que roda em `asyncio.to_thread` (skilled.py:77). Um
  `requests.post` bloqueante ali é correto.
- **Timeout é obrigatório** (espelha `catalog._EXTERNAL_TIMEOUT = 10`). Usamos um
  par connect/read `(3.05, 10s)`: os 3.05s de connect toleram o handshake TLS +
  cold start; o read de 10s evita travar o turno se a Lambda morrer.

**Upgrade de produção:** trocar `AuthType` da Function URL de `NONE` para `AWS_IAM`
quando o Railway puder assumir um role; API Gateway só se precisar de WAF/edge.

### 4.2 Configuração: **substituição no registry a partir de UMA env var**

**Escolha:** uma única env var JSON, `SKILL_REMOTES` (mapa `nome -> URL`), lida em
`app/config.py` no padrão `os.getenv`-no-import já existente:

```python
# app/config.py
SKILL_REMOTES = json.loads(os.getenv("SKILL_REMOTES", "{}"))
# ex.: {"send_email": "https://abc123.lambda-url.us-east-1.on.aws/"}
SKILL_HMAC_SECRET    = os.getenv("SKILL_HMAC_SECRET", "")
SKILL_REMOTE_TIMEOUT = float(os.getenv("SKILL_REMOTE_TIMEOUT", "10"))
SKILL_LOCAL_DEV      = os.getenv("SKILL_LOCAL_DEV", "0") == "1"  # libera http://localhost
# Skills que NUNCA podem ir remoto (atalhos de 0 token — ver §8).
REMOTE_SKILL_DENYLIST = {"escalate_to_human", "knowledge_search"}
```

Aplicada **uma vez, no import**, como **última linha** de `app/skills/__init__.py`
(depois que os submódulos registraram suas `LocalSkill`s):

```python
from app.skills.remote import promote_remote_skills
promote_remote_skills()   # troca REGISTRY[name] por RemoteSkill.from_local(...)
```

`promote_remote_skills()` faz, para cada `nome -> url` em `SKILL_REMOTES`:
`REGISTRY[name] = RemoteSkill.from_local(REGISTRY[name], url)`.

**Por que substituição (e não um `flag` na skill, nem coluna no banco):**
- Copiar `name/description/args_model/category` da local mantém schema, seleção e
  prompt **mecanicamente idênticos** (o invariante de fonte única é honrado por
  construção, não por disciplina).
- **Por plataforma** (não por tenant) — ver §4.5.

**Alternativa considerada:** um par de env vars por tool
(`SKILL_REMOTE_<NOME>_URL` / `_SECRET`). Dá **segredo por tool** (ganho real de
segurança), mas multiplica env vars e é chato de enumerar. Fica como **v2**: o
*valor* de `SKILL_REMOTES` pode crescer de `"url"` para `{"url":..., "secret_env":...}`
**sem mudar a classe `RemoteSkill`**.

> **Trade-off honesto:** a config é lida no import, então flipar uma skill para
> remota exige **restart/redeploy da API** (não há hot-reload). É aceitável — é uma
> operação rara e deliberada.

### 4.3 Compartilhamento de código: **uma lógica pura, dois runtimes**

**Escolha:** a lógica de negócio vive **uma vez** e os dois runtimes a importam.
Camadas (espelha como as skills de catálogo já são finas sobre `app/catalog.py`):

```
app/notifications.py     ← lógica pura de envio de e-mail; SEM FastAPI, registry ou
                            transporte. Importável pela skill E pela Lambda.
app/skills/email.py      ← @skill("send_email", ...) + SendEmailArgs; o handler só
                            chama app.notifications.send_email(...). É a LocalSkill.
lambdas/handler.py       ← handler genérico: chama invoke_skill(req["skill"], ...) —
                            o MESMO dispatch+validação da API. Não reimplementa nada.
```

**Por que a Lambda chama `invoke_skill` (e não a função pura direto):** assim a
Lambda roda **a mesma validação Pydantic** (`args_model.model_validate`) e a mesma
semântica "degrada para `{error}`" que a API. **Não existe um segundo caminho de
código para divergir** — a Lambda literalmente executa `app/skills/email.py::_send_email`.

### 4.4 Segurança: **HMAC fail-closed + projeção allowlist do AgentConfig**

Esta é a aresta afiada do desenho. Dois pontos não-negociáveis:

**(a) AuthN API→Lambda — HMAC-SHA256, fail-closed.**
A `RemoteSkill` assina `timestamp + "." + corpo_bruto` com `SKILL_HMAC_SECRET` e
envia `X-Blip-Signature: sha256=<hex>` + `X-Blip-Timestamp`. A Lambda recomputa,
compara com `hmac.compare_digest` (tempo constante) e **rejeita** se a assinatura
faltar/divergir ou se o timestamp tiver mais de 300s (janela de replay).
**Assinatura ausente/ inválida ⇒ a skill nunca executa.** A Function URL pode ser
`AuthType=NONE` no protótipo **porque o HMAC é o portão** (e é testável em
localhost, sem credencial AWS).

**(b) Egress de segredo — NUNCA `asdict(agent)`.**
`SkillContext.agent` é o **`AgentConfig` inteiro**, que carrega `product_api_key`
(um `Bearer` real — catalog.py:156), `system_prompt` e `business_rules`. Serializar
o ctx ingenuamente **mandaria a chave do tenant para a Lambda.** Mitigação
obrigatória: a `RemoteSkill` monta o `agent` do fio a partir de uma **allowlist
explícita**, jamais de `dataclasses.asdict()`:

```python
# projeção default enviada no fio (app/skills/remote.py)
_AGENT_WIRE_FIELDS = ("id", "tenant_id", "slug", "name",
                      "product_mode", "rag_enabled", "external_products")
# product_api_key / system_prompt / business_rules: AUSENTES por construção.
# product_api_url só entra para skills category == CATEGORY_CATALOG.
```

Um **teste de CI** afirma que `product_api_key` (e `system_prompt`/`business_rules`)
**nunca** aparecem no corpo do request. `agent_from_wire(d)` reconstrói o
`AgentConfig` com os defaults do frozen dataclass — os campos secretos voltam como
`""`.

**(c) A resposta da Lambda é entrada confiável do LLM** (o JSON volta para o modelo)
→ superfície de prompt-injection. A `RemoteSkill` **limita o tamanho** do corpo de
resposta e **valida o shape** antes de remontar o `SkillResult` (espelha o parsing
defensivo de catalog.py:165-172). E `send_email` **não ecoa o corpo do e-mail** em
`sources` — só um resumo de confirmação.

**(d) SSRF:** as URLs de `SKILL_REMOTES` são **definidas pelo operador** (env da
plataforma), **não pelo tenant** — não é a superfície de SSRF do `product_api_url`.
Ainda assim, no `promote_remote_skills()` exigimos `https://` (só `http://localhost`
quando `SKILL_LOCAL_DEV=1`), `allow_redirects=False`, `verify=True`.

> Reconcilia o lens de segurança com o de protótipo: **segredo HMAC único
> compartilhado** (não por tool) e `send_email` **sem provider real**. Segredo por
> tool + `product_api_key` via Secrets Manager são o **v2** documentado (§10).

### 4.5 Escopo: **por plataforma**, anexação por agente inalterada

**Escolha:** `SKILL_REMOTES` é **global da plataforma** (`nome -> uma URL`). A
meta é **isolar deploy por tool** (uma tool = uma Lambda, redeployável sozinha) — e
isso se resolve no nível da plataforma. **Qual** tool cada agente usa continua
exatamente onde está: `AgentConfig.skills` (editado na UI, validado por
`_check_skills`). A identidade do tenant viaja no `agent.tenant_id` do fio, então a
Lambda ainda pode se comportar por tenant.

**Por que não por tenant agora:** rotear a *mesma* tool para Lambdas diferentes por
tenant exigiria coluna no banco + migração + campo na UI + mudar a chave do
`lru_cache` sobre o `AgentConfig` frozen — diff grande, sem ganho no protótipo.
**v2:** indexar `SKILL_REMOTES` por `tenant:skill`; a classe `RemoteSkill` não muda,
só o lookup no `promote_remote_skills()`.

### 4.6 Empacotamento: **um handler genérico, artefato de deploy por tool**

**Escolha:** **um** `lambdas/handler.py` genérico que lê o nome da skill **do
payload** (não de uma env `SKILL_NAME`). Assim o handler é idêntico para todas as
tools e o shim local serve todas de um processo só. O handler empacota `app/` e
chama `invoke_skill(req["skill"], req["args"], ctx)`.

Cada tool é a **sua própria Lambda + Function URL**. Deployar `send_email` toca
**só** `blip-skill-send-email` — nunca a API, nunca outra tool. `lambdas/local_server.py`
é um shim uvicorn de ~20 linhas que expõe o `lambda_handler` em `localhost:9000`.

**Upgrade de produção:** ler `SKILL_NAME` da env e empacotar **só**
`app/skills/<tool>.py` + `base.py` + `domain.py` (em vez de `app/` inteiro) — escopa
deps e IAM por tool de verdade (ver risco em §9.1).

### 4.7 `send_email`: **opt-in**, remetente derivado do agente

A nova tool é a primeira candidata a Lambda (sem estado/DB/RAG ⇒ blast radius zero).

```python
class SendEmailArgs(BaseModel):
    to: EmailStr                          # valida o destinatário (limita input do LLM)
    subject: str = Field(max_length=200)
    body: str    = Field(max_length=5000)
    # SEM campo 'from': o remetente vem de ctx.agent, NUNCA do modelo (anti-spoofing).
```

- **Backend default `EMAIL_BACKEND="log"`**: registra e confirma, **sem provider e
  sem credencial** → demonstrável no Railway hoje. `"smtp"` (via `smtplib` da
  stdlib) e, no futuro, `"ses"` dentro da Lambda são opcionais.
- **Opt-in obrigatório** (ver §8): um agente só ganha `send_email` se **listar**
  explicitamente em `AgentConfig.skills`. Não pode ser derivada de flag.
- `EmailStr` requer `pydantic[email]` (`email-validator`) — ver decisão em aberto Q6.

---

## 5. Fluxos passo a passo

### 5.1 Runtime — uma chamada de tool remota
1. O LLM, no loop de function calling do `SkilledAgent`, pede `send_email(args)`.
2. `invoke_skill("send_email", raw_args, ctx)` valida `raw_args` com `SendEmailArgs`.
3. O registry resolve `RemoteSkill` → `invoke(ctx, args)`.
4. `RemoteSkill` monta o envelope: `_agent_to_wire(ctx.agent)` (allowlist) + `args.model_dump()`.
5. Assina HMAC sobre `timestamp + "." + corpo`; `requests.post(url, json, headers, timeout=(3.05,10))`.
6. A Lambda verifica a assinatura (fail-closed), reconstrói o `ctx`, chama
   `invoke_skill` (mesma validação), roda `_send_email`, devolve 200 com o `SkillResult`.
7. A `RemoteSkill` valida o shape, remonta `SkillResult` e devolve ao loop.
8. **Qualquer falha** (não-200, timeout, sig inválida, corpo grande) ⇒
   `SkillResult(data={"error": ...})` — **igual ao contrato de `invoke_skill` hoje**
   (base.py:200-212): o loop do agente não muda e a request **nunca cai**; o erro
   vira saída de tool comum que o LLM lê e contorna.

### 5.2 Config — tornar uma tool remota
1. Deploy da Lambda da tool (§5.3) → obtenha a Function URL.
2. No Railway, defina/edite `SKILL_REMOTES` com `{"send_email": "<URL>"}` e garanta
   `SKILL_HMAC_SECRET` igual nos dois lados.
3. **Restart da API.** No boot, `promote_remote_skills()` troca `REGISTRY["send_email"]`
   por uma `RemoteSkill`. **Nenhuma outra skill muda.** Schema, seleção e prompt: idênticos.

### 5.3 Deploy independente de uma tool
- A tool é uma Lambda própria (`blip-skill-send-email`) com Function URL própria.
- `aws lambda update-function-code --function-name blip-skill-send-email ...`
  (ou `sam deploy`) atualiza **só ela**. A API não reinicia; outras tools não são
  tocadas. ✅ É exatamente "deployar uma tool sem afetar nenhuma outra".

### 5.4 Teste local (sem AWS)
1. `python lambdas/local_server.py` sobe o `lambda_handler` em `localhost:9000`.
2. `SKILL_LOCAL_DEV=1`, `SKILL_REMOTES={"send_email":"http://localhost:9000/"}`,
   `SKILL_HMAC_SECRET=dev`.
3. Suba a API: o caminho remoto inteiro (envelope, HMAC, projeção, parsing) roda
   contra o shim local — mesma `RemoteSkill`, mesmo `lambda_handler`.

---

## 6. Contrato de fio (fonte única dos dois lados)

```
REQUEST  POST <function-url>
  headers:
    Content-Type: application/json
    X-Blip-Timestamp: <unix seconds>
    X-Blip-Signature: sha256=<hex HMAC_SHA256(secret, ts + "." + corpo_bruto)>
  body:
    {
      "v": 1,
      "skill": "send_email",
      "agent": { "id","tenant_id","slug","name",
                 "product_mode","rag_enabled","external_products" },   // allowlist; SEM product_api_key
      "args":  { "to","subject","body" }
    }

RESPONSE 200
    {
      "data": { "sent": true, "backend": "log", "to": "cliente@x.com" },
      "handoff": false,
      "handoff_reason": null,
      "direct_response": null,
      "sources": []
    }
```

- Os campos da resposta **espelham 1:1** o `SkillResult` (`data`, `handoff`,
  `handoff_reason`, `direct_response`, `sources`).
- **Degradação:** qualquer não-200 / timeout / assinatura inválida ⇒ a `RemoteSkill`
  devolve `SkillResult(data={"error": "send_email indisponível"})`.
- **Args validados duas vezes** contra o **mesmo** `SendEmailArgs` (na API antes do
  envio; na Lambda ao receber) — fonte única preservada.
- O campo `"v"` (versão de contrato) existe para detectar divergência de schema entre
  deploys (ver risco §9.2).

---

## 7. Onde o código encosta (e o que NÃO muda)

| Ação | Arquivo | Papel |
|---|---|---|
| NOVO | `app/notifications.py` | lógica pura de e-mail (sem transporte/registry) |
| NOVO | `app/skills/email.py` | skill `send_email` (`@skill` + `SendEmailArgs`) |
| NOVO | `app/skills/remote.py` | `RemoteSkill`, `_agent_to_wire`/`agent_from_wire`, `sign`/`verify_signature`, `promote_remote_skills` |
| NOVO | `lambdas/handler.py` | handler genérico (chama `invoke_skill`) |
| NOVO | `lambdas/local_server.py` | shim uvicorn p/ testar sem AWS |
| NOVO | `lambdas/send_email/` | `requirements.txt` + `template.yaml` (deploy isolado) |
| NOVO | `tests/test_remote_skill.py` | paridade, deny de segredo, fail-closed, denylist |
| EDIT | `app/config.py` | `SKILL_REMOTES`, `SKILL_HMAC_SECRET`, timeout, dev, denylist, `EMAIL_BACKEND` |
| EDIT | `app/skills/__init__.py` | importa `email`; chama `promote_remote_skills()` no fim |
| EDIT | `app/skills/base.py::enabled_skills_for` | não auto-derivar `send_email` (§8 / Q1) |
| EDIT | `.env.example`, `docs/ARQUITETURA.md` | env novas; §3/§11 de "desenhado" → "implementado p/ send_email" |
| EDIT? | `requirements.txt` | `pydantic[email]` (Q6) |

**NÃO muda (o objetivo do desenho):** `app/agents/skilled.py`, `to_tool_schema`,
`tool_schemas_for`, a lógica de seleção de `enabled_skills_for`, `AgentService._check_skills`,
os prompts, o shape do `AgentConfig`, o loop do agente.

---

## 8. Invariantes que não podem quebrar

1. **Denylist de skills remotas — `{escalate_to_human, knowledge_search}`.**
   O `SkilledAgent` roda **duas skills FORA do loop do LLM**, a 0 token:
   - fast-path 1 (skilled.py:59-68): escalonamento por palavra-chave chama
     `escalate_to_human` direto;
   - fast-path 2 (skilled.py:71-94): atalho RAG chama `knowledge_search` direto.
   Tornar qualquer uma **remota destrói esses atalhos**: todo turno faria um
   round-trip de rede (+ cold start) no caminho determinístico mais quente, com
   latência catastrófica e uma Lambda morta quebrando escalonamento/RAG. Pior,
   `knowledge_search` remoto puxaria Jina + sqlite-vec para a Lambda e faria
   round-trip do atalho **em toda mensagem**. Por isso `promote_remote_skills()`
   **recusa (pula + loga)** qualquer nome na `REMOTE_SKILL_DENYLIST`. **É guard, não
   nota de doc.**
2. **`send_email` é opt-in.** `enabled_skills_for` inclui as categorias
   `GENERAL`/`SUPPORT` no caminho derivado-de-flags. Adicionar `send_email` como
   `GENERAL` ingênuo daria a **todo agente legado** (com `skills` vazio) uma tool de
   e-mail que o LLM poderia disparar sozinho — regressão de tokens **e** risco de
   abuso. Logo, `send_email` **não pode ser derivada**: só vale se o agente a
   **listar** explicitamente. (Implementação: excluir do conjunto derivado — ver Q1.)
3. **Schema nunca dessincroniza do dispatch.** Garantido por construção:
   `RemoteSkill` copia `args_model`; a Lambda valida com o mesmo modelo. O único
   vetor real de desync é **deployar `args_model` editado em só um lado** — coberto
   pelo `"v"` do contrato + teste de paridade em CI.
4. **Segredo nunca sai no fio por engano.** Allowlist explícita + teste de deny
   (`product_api_key`/`system_prompt`/`business_rules` ausentes).
5. **Uma skill nunca derruba a request.** `RemoteSkill.invoke` **nunca levanta** —
   degrada para `{error}`, honrando o contrato de `invoke_skill` (base.py:200-212).

---

## 9. Riscos e mitigações

| # | Risco | Mitigação |
|---|---|---|
| 9.1 | **Bundle `app/` compartilhado** em toda Lambda: editar `catalog.py` muda o artefato do `send_email`. Isolamento de *deploy* vale; de *superfície de código* vaza. | `app/notifications.py` dependency-free; em produção, empacotar só `app/skills/<tool>.py`+`base.py`+`domain.py` (handler por `SKILL_NAME`). Documentado como upgrade. |
| 9.2 | **Desync de `args_model`** entre deploys independentes (API emite schema de uma cópia; Lambda valida com outra). | Campo `"v"` no fio; tratar `email.py` como contrato que deploia nos dois lados; teste de paridade em CI. |
| 9.3 | **Auto-recursão:** se a env `SKILL_REMOTES` vazar para dentro da Lambda, ela tentaria promover `send_email` e chamar **a si mesma** → loop/DoS. | `promote_remote_skills()` é **no-op dentro da Lambda** (guard em `AWS_LAMBDA_FUNCTION_NAME`); o handler importa `app.skills.base` sem disparar o pass de promoção. |
| 9.4 | **Cold start / latência** no loop de tools. | Timeout `(3.05, 10s)`; manter os fast-paths de 0 token **sempre locais** (§8); provisioned concurrency p/ tools quentes em produção. |
| 9.5 | **Resposta da Lambda é input confiável do LLM** (prompt injection se a Lambda for comprometida/buggada). | Cap de tamanho + validação de shape na remontagem do `SkillResult`. |
| 9.6 | **Mismatch de segredo HMAC** degrada em silêncio (LLM "se desculpa" que não consegue enviar). | Probe diagnóstico `check_remote_skill` (análogo a `check_catalog`) + log no rebinding do `promote`. |
| 9.7 | **`AuthType=NONE`**: a Function URL é alcançável pela internet; o único portão é o HMAC. Um refactor fail-open abriria a tool. | Teste fail-closed obrigatório; `AWS_IAM` como defense-in-depth no v2. |
| 9.8 | **Vazamento por `asdict`**: um dev futuro adiciona campo secreto a `_AGENT_WIRE_FIELDS` ou troca por `asdict`. | Teste de deny explícito barra `product_api_key`/prompts no fio. |

---

## 10. Caminho de produção (v2) — explicitamente adiado

- **Segredo por tool:** valor de `SKILL_REMOTES` cresce para `{"url","secret_env"}`
  sem mudar `RemoteSkill`.
- **`product_api_key` p/ uma futura skill de catálogo remota:** **não** mandar a
  chave no fio — mandar só `agent_id` e a Lambda busca a chave no **AWS Secrets
  Manager** via seu próprio role (least privilege).
- **`AuthType=AWS_IAM`** na Function URL quando o Railway puder assumir role.
- **Roteamento por tenant:** `SKILL_REMOTES` indexado por `tenant:skill`.
- **Bundle enxuto por tool** (risco 9.1) + IAM/deps escopados por Lambda.
- **Provider de e-mail real** (SES dentro da Lambda — credencial só no role da Lambda).

---

## 11. Decisões em aberto (precisam de você) — com default recomendado

| # | Decisão | Recomendação |
|---|---|---|
| Q1 | `send_email` **opt-in** vs derivada de flag? | **Opt-in only** — legado nunca ganha e-mail silenciosamente (§8). |
| Q2 | Escopo **por plataforma** vs por tenant? | **Por plataforma** (`SKILL_REMOTES` global); per-tenant é v2 limpo. |
| Q3 | Provider de e-mail real no protótipo? | **`EMAIL_BACKEND="log"`** prova a arquitetura sem credencial; SES dentro da Lambda se precisar enviar de verdade. |
| Q4 | Segredo HMAC **único** vs por tool? | **Único** (`SKILL_HMAC_SECRET`) no protótipo; por tool é v2. |
| Q5 | Function URL `NONE`+HMAC vs `AWS_IAM`? | **`NONE`+HMAC** (sem credencial AWS no Railway; testável em localhost). |
| Q6 | Adicionar `pydantic[email]` p/ `EmailStr`? | **Adicionar** (valida destinatário, limita input do LLM); senão `str`+regex. |

---

*Este documento é o desenho aprovado pela rodada de design (3 propostas
independentes — simplicidade / produção / segurança — + síntese adversarial). A
implementação segue a ordem da §7.*
