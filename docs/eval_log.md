# Relatório de avaliação — blip-agent

- Modelo LLM: `llama-3.3-70b-versatile`
- HISTORY_LIMIT: 5 mensagens · RAG_TOP_K: 3 chunks
- Base: FAQ Loja Demo (`docs/fixtures/faq_loja_demo.txt`)

## 1. Teste de embeddings (Jina API)

- Modelo: `jina-embeddings-v3` · dimensão configurada: **384**

- Dimensão dos vetores retornados: **384** (OK)
- Norma L2 média: **1.0000** (normalizado ✓)
- Latência de embedding (5 passagens em lote): **960 ms**

Matriz de similaridade (cosseno) — pergunta (linha) × tópico (coluna). Diagonal = match correto:

| pergunta \ tópico | horario | pagamento | entrega | garantia | trocas |
|---|---|---|---|---|---|
| que horas a loja abre? | **0.809** | 0.120 | 0.146 | 0.108 | 0.187 ✓ |
| posso parcelar no cartao? | 0.071 | **0.552** | 0.130 | 0.045 | 0.104 ✓ |
| quanto tempo demora pra cheg | 0.229 | 0.073 | **0.650** | 0.242 | 0.410 ✓ |
| qual a garantia dos produtos | 0.129 | 0.048 | 0.115 | **0.706** | 0.377 ✓ |
| como faço pra devolver um pr | 0.087 | 0.051 | 0.122 | 0.273 | **0.408** ✓ |

**Acerto top-1 dos embeddings: 5/5 (100%)**

### Ingestão do FAQ

- Chunks criados: **10** · tempo de ingestão (chunk+embed+gravação): **794 ms**

## 2. Teste de RAG + chat — acurácia, tokens e fonte

Histórico vazio (cada pergunta é independente). Acurácia = fato esperado presente na resposta.

| # | Pergunta | Intent (conf.) | Agente/Fonte | Tokens | Latência | Acerto |
|---|----------|----------------|--------------|--------|----------|--------|
| 1 | qual o horario de funcionamento da loja  | faq (0.89) | faq/faq_shortcut | 0 | 641 ms | ✓ |
| 2 | ate quantas vezes posso parcelar no cart | faq (0.97) | faq/llm_rag | 895 | 1404 ms | ✓ |
| 3 | tem desconto no pix? | faq (0.77) | faq/llm_rag | 864 | 990 ms | ✓ |
| 4 | quanto tempo demora a entrega para capit | support (0.77) | support/llm | 210 | 513 ms | ✗ |
| 5 | quanto custa a entrega expressa? | order (0.89) | order/llm | 664 | 375 ms | ✗ |
| 6 | qual o prazo para trocar um produto por  | faq (0.97) | faq/faq_shortcut | 0 | 1615 ms | ✓ |
| 7 | qual a garantia dos produtos eletronicos | faq (0.89) | faq/faq_shortcut | 0 | 987 ms | ✓ |
| 8 | quanto custa a garantia estendida? | order (0.89) | order/llm | 665 | 398 ms | ✗ |
| 9 | como funciona o programa de fidelidade? | faq (0.89) | faq/llm_rag | 1062 | 2332 ms | ✓ |
| 10 | voces aceitam cheque? | faq (0.77) | faq/llm_rag | 824 | 1211 ms | ✓ |
| 11 | como rastreio meu pedido? | faq (0.89) | faq/faq_shortcut | 0 | 899 ms | ✓ |
| 12 | posso cancelar meu pedido depois de envi | support (0.77) | support/support_escalation | 0 | 2 ms | ✗ |

**Acurácia factual: 8/12 (67%)**
- Tokens totais: **5184** · média **432**/pergunta
- Atalhos sem LLM (faq_shortcut, 0 tokens): **4/12**
- Latência média: **947 ms**/pergunta

<details><summary>Respostas completas (amostra)</summary>

**P:** qual o horario de funcionamento da loja fisica?  
**R** (faq_shortcut, 0 tok) ✓**:** Horario de funcionamento

A Loja Demo atende de segunda a sexta-feira das 9h as 18h e aos sabados das 10h as 14h. Aos domingos e feriados nacionais a loja fisica permanece fechada.
O atendimento online pelo site e pelo WhatsApp funciona de segunda a sexta das 8h as 20h e aos sabados das 9h as 16h. Pedidos realizados fora desse horario sao processados no proximo dia util.
Em feriados estaduais e municipais o horario pode variar. Consulte nossa pagina nas redes sociais para avisos de funcionamento especial.

**P:** ate quantas vezes posso parcelar no cartao de credito?  
**R** (llm_rag, 895 tok) ✓**:** Você pode parcelar em até 12 vezes sem juros para compras acima de R$ 300,00. Para compras abaixo desse valor, o parcelamento é em até 3 vezes sem juros.

**P:** tem desconto no pix?  
**R** (llm_rag, 864 tok) ✓**:** Sim, pagamentos via PIX recebem desconto automático de 5% sobre o valor total do pedido.

**P:** quanto tempo demora a entrega para capitais?  
**R** (llm, 210 tok) ✗**:** Olá! Para capitais, o prazo de entrega é de 3 a 5 dias úteis. Se tiver alguma dúvida adicional ou precisar de mais informações, basta perguntar!

**P:** quanto custa a entrega expressa?  
**R** (llm, 664 tok) ✗**:** [HANDOFF] Desculpe, mas não tenho informações sobre o custo da entrega expressa. Posso ajudar com algo mais relacionado ao catálogo ou estoque de produtos?

**P:** qual o prazo para trocar um produto por arrependimento?  
**R** (faq_shortcut, 0 tok) ✓**:** Politica de trocas e devolucoes

O cliente tem direito a solicitar troca ou devolucao em ate 7 dias corridos apos o recebimento do produto, conforme o Codigo de Defesa do Consumidor. Para exercer esse direito basta acessar a area 'Meus pedidos', selecionar o item e clicar em 'Solicitar troca ou devolucao'.
Para que a troca ou devolucao seja aceita o produto deve estar na embalagem original, sem sinais de uso, com todos os acessorios e manuais incluidos. Produtos com lacre violado somente sao aceitos se apresentarem defeito comprovado.
Em caso de defeito de fabricacao o prazo para reclamacao e de 30 dias para produtos nao duraveis e de 90 dias para produtos duraveis, contados a partir do recebimento. O frete de devolucao e por conta da Loja Demo nos casos de defeito ou erro no envio.
Para trocas por arrependimento (sem defeito) o frete de devolucao e por conta do cliente. Apos recebermos o produto em condicoes adequadas o reembolso e processado em ate 10 dias uteis para cartao de credito e em ate 5 dias uteis para PIX.

**P:** qual a garantia dos produtos eletronicos?  
**R** (faq_shortcut, 0 tok) ✓**:** Garantia dos produtos

Todos os produtos eletronicos vendidos pela Loja Demo possuem garantia minima de 12 meses contra defeitos de fabricacao, contados a partir da data de compra. Essa garantia e oferecida pelo fabricante e pela Loja Demo em conjunto.
A garantia cobre defeitos de fabricacao, falhas em componentes internos e problemas de funcionamento sem causa externa identificavel. A garantia nao cobre danos fisicos causados por quedas ou impactos, danos por liquidos, desgaste natural pelo uso, modificacoes nao autorizadas ou mau uso do produto.
A Loja Demo oferece garantia estendida de 24 meses por R$ 49,90 para produtos acima de R$ 500,00. A garantia estendida pode ser adquirida no momento da compra ou em ate 7 dias apos o recebimento do produto.
Para acionar a garantia o cliente deve entrar em contato com o suporte informando o numero do pedido e descrevendo o defeito. Nossa equipe tecnica fara a analise e, se confirmado o defeito coberto pela garantia, providenciara o reparo ou substituicao sem custo adicional.

**P:** quanto custa a garantia estendida?  
**R** (llm, 665 tok) ✗**:** [HANDOFF] Desculpe, mas não tenho informações sobre a garantia estendida. Posso ajudar com algo mais relacionado ao catálogo ou estoque de produtos?

**P:** como funciona o programa de fidelidade?  
**R** (llm_rag, 1062 tok) ✓**:** O programa de fidelidade Loja Demo Plus oferece pontos a cada compra realizada no site ou na loja física. A cada R$ 1,00 gasto, o cliente acumula 1 ponto. Os pontos podem ser trocados por descontos nas próximas compras, onde 100 pontos equivalem a R$ 5,00 de desconto. Além disso, clientes com mais de 5.000 pontos acumulados atingem o nível Gold e recebem benefícios como frete grátis em compras acima de R$ 150,00, acesso antecipado a promoções e atendimento prioritário no suporte. Os pontos expiram em 12 meses a partir da data em que foram acumulados.

**P:** voces aceitam cheque?  
**R** (llm_rag, 824 tok) ✓**:** Nao aceitamos cheques como forma de pagamento.

**P:** como rastreio meu pedido?  
**R** (faq_shortcut, 0 tok) ✓**:** Como rastrear meu pedido

Apos o envio do pedido o cliente recebe um e-mail com o codigo de rastreamento e o link direto para acompanhar a entrega no site dos Correios ou da transportadora responsavel. O codigo de rastreamento tambem fica disponivel na area 'Meus pedidos' no site da Loja Demo.
A atualizacao do rastreamento pode levar ate 24 horas apos a postagem para aparecer no sistema da transportadora. Se apos 48 horas do envio o rastreamento ainda nao apresentar movimentacao, entre em contato com nosso suporte.

**P:** posso cancelar meu pedido depois de enviado?  
**R** (support_escalation, 0 tok) ✗**:** Entendo que isso é importante e quero garantir que seja resolvido da melhor forma. Vou transferir você para um atendente humano que poderá cuidar disso agora mesmo.

</details>

## 4. Diagnóstico de roteamento — as falhas são do classificador, não do RAG

As perguntas que falharam na bateria 2 foram desviadas por palavras-chave ("custa", "demora", "cancelar") para os agentes de pedido/suporte, que **não consultam a base de conhecimento**. Aqui forçamos as mesmas perguntas pelo FAQAgent (RAG) para mostrar que a informação está recuperável:

| Pergunta | Roteamento real (bateria 2) | Forçado p/ FAQ | Acerto |
|----------|------------------------------|----------------|--------|
| quanto tempo demora a entrega para cap | support → resposta inventada | llm_rag | ✓ |
| quanto custa a entrega expressa? | order → handoff | llm_rag | ✓ |
| quanto custa a garantia estendida? | order → handoff | llm_rag | ✓ |
| posso cancelar meu pedido depois de en | support → handoff automático | faq_shortcut | ✓ |

**Recuperação correta ao rotear p/ FAQ: 4/4 — ou seja, o RAG tinha a resposta; o classificador é o gargalo.**

<details><summary>Respostas forçadas pelo FAQ</summary>

**P:** quanto tempo demora a entrega para capitais?  
**R** ✓**:** Para capitais e regiões metropolitanas, o prazo de entrega é de 2 a 4 dias úteis. Se você optar pela entrega expressa (disponível para capitais), a entrega pode ser feita no dia seguinte, com um acréscimo de R$ 19,90 no frete, desde que o pedido seja feito até as 14h em dias úteis.

**P:** quanto custa a entrega expressa?  
**R** ✓**:** A entrega expressa tem um acréscimo de R$ 19,90 no frete. Ela garante a entrega no dia seguinte para pedidos feitos até as 14h em dias úteis, e está disponível apenas para capitais.

**P:** quanto custa a garantia estendida?  
**R** ✓**:** A garantia estendida de 24 meses custa R$ 49,90 para produtos acima de R$ 500,00.

**P:** posso cancelar meu pedido depois de enviado?  
**R** ✓**:** Cancelamento de pedido

Pedidos podem ser cancelados sem custo ate o momento em que o produto e postado para envio. Para verificar se o cancelamento ainda e possivel acesse 'Meus pedidos' e clique em 'Cancelar pedido'. Se a opcao nao estiver disponivel o produto ja foi despachado.
Apos o envio o cancelamento nao e mais possivel diretamente. Nesse caso o cliente deve aguardar o recebimento e solicitar a devolucao conforme a politica de trocas e devolucoes descrita neste documento.
O reembolso de pedidos cancelados antes do envio e processado em ate 3 dias uteis para PIX e em ate 10 dias uteis para cartao de credito, podendo aparecer na fatura do mes seguinte dependendo da operadora do cartao.

</details>

## 3. Casos fora do escopo — devem fazer handoff (não alucinar)

| Pergunta | Fonte | Handoff? | Resposta (início) |
|----------|-------|----------|-------------------|
| qual o cnpj da loja demo? | llm_rag | ✓ sim | Vou transferir você para um atendente humano para ajudar com... |
| voces vendem geladeira? | llm | ✗ não | Sim, vendemos geladeiras. Qual é o modelo ou tamanho que voc... |
| qual o salario do CEO da empresa? | llm_rag | ✓ sim | Vou transferir você para um atendente humano para ajudar com... |

**Handoff correto em casos fora de escopo: 2/3**
