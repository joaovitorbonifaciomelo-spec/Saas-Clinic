# Proposta técnica — Módulo Atendimento

> **Status: proposta. Nada implementado.** Nenhuma migration escrita, nenhum
> endpoint criado, nenhuma tela feita. Este documento existe para ser aprovado,
> corrigido ou recusado antes de qualquer código.

---

## 1. Fluxo do usuário

O módulo nasce de um fluxo que já acontece hoje, fora do sistema:

```
paciente manda mensagem no WhatsApp da clínica
        │
        ▼
recepção vê a mensagem numa caixa compartilhada
        │
        ├── reconhece o número?  não ──► cadastra paciente OU deixa sem vínculo
        │                        sim ──► abre a ficha
        ▼
alguém ASSUME a conversa (para os outros saberem que já tem dono)
        │
        ├── resolve na hora            ──► encerra
        ├── precisa agendar/reagendar  ──► abre a agenda, marca, volta e responde
        ├── depende de resposta do paciente ──► marca "aguardando paciente"
        └── depende de alguém de dentro ──► (hoje vira bilhete na mesa)
        │
        ▼
paciente responde dias depois ──► conversa VOLTA para a fila
```

Três fatos desse fluxo governam o desenho inteiro:

1. **A caixa é compartilhada, não pessoal.** Duas ou três pessoas trabalham a
   mesma fila. Tudo que for "meu" precisa ser explícito, não implícito.
2. **A conversa não termina de verdade.** Encerrar é dizer "por ora não há o que
   fazer". O paciente pode escrever de novo em março sobre o assunto de janeiro.
3. **O que a secretária precisa lembrar quase nunca é "responder a mensagem".**
   É "pedir o exame", "confirmar com a doutora", "ligar amanhã". Isso é
   pendência, não estado de conversa — e é o item mais fácil de errar aqui.

---

## 2. Entidades

Quatro tabelas. Justifico cada uma, inclusive a que quase não propus.

| Entidade | Papel |
|---|---|
| `contacts` | Quem fala com a clínica por um canal. É onde mora o vínculo com o paciente. |
| `conversations` | A thread com um contato. Carrega estado, responsável e leitura. |
| `messages` | Cada mensagem, entrando ou saindo. |
| `conversation_events` | Log append-only de quem fez o quê. |

### Por que `contacts` separado de `conversations`

Considerei juntar: uma conversa por contato, telefone direto na conversa, menos
uma tabela. Mantive separado por três motivos concretos:

- **O vínculo com paciente sobrevive à conversa.** "Este número é a Mariana" é
  conhecimento da clínica, não daquele atendimento. Com o telefone na conversa,
  esse trabalho é refeito toda vez que a conversa é encerrada e reaberta.
- **Um paciente tem mais de um número** (o dele, o da filha que marca por ele).
  Contato aponta para paciente; paciente não aponta para um telefone só.
- **Permite episódios depois sem partir tabela.** Se um dia decidirmos que cada
  atendimento é uma conversa nova, basta permitir N conversas por contato. Com
  telefone na conversa, isso seria uma migration de separação com backfill.

**Contra-argumento honesto:** enquanto houver um canal e uma conversa por
contato, as duas tabelas são quase 1:1 e `contacts` parece burocracia. Se
preferirem começar sem ela, a decisão é reversível — só fica mais cara depois.

### Por que NÃO propus `ConversationAssignment` como tabela

O responsável atual é uma coluna (`assigned_to`). O histórico de atribuições é
uma sequência de eventos. Uma terceira tabela seria uma segunda representação da
mesma verdade, com risco de discordar da coluna. Coluna + log resolve.

---

## 3. Campos

Seguindo as convenções já estabelecidas: `id uuid` com `gen_random_uuid()`,
`clinic_id` em tudo, `unique (clinic_id, id)` para permitir FK composta,
`created_at` / `updated_at` com trigger.

### `contacts`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `clinic_id` | uuid NOT NULL | → `clinics(id)` ON DELETE CASCADE |
| `channel` | enum `conversation_channel` | `whatsapp` \| `manual` |
| `external_id` | text NOT NULL | Identidade **no canal**. Para WhatsApp, o número em E.164. Para `manual`, o telefone digitado. |
| `display_name` | text NULL | Nome que o canal informa. Não é o nome do paciente. |
| `patient_id` | uuid NULL | Vínculo, quando identificado |
| `created_at` / `updated_at` | timestamptz | |

- `unique (clinic_id, channel, external_id)` — um contato por número por canal
  por clínica. É o que torna a ingestão idempotente na chegada.
- `unique (clinic_id, id)` — habilita as FKs compostas abaixo.
- FK composta: `(clinic_id, patient_id) → patients(clinic_id, id)` ON DELETE SET
  NULL. Apagar o paciente não pode apagar o histórico da conversa.

**`external_id` é normalizado na borda, nunca no banco.** O mesmo número chega
como `5511987654321`, `+55 11 98765-4321` e `11987654321`. A normalização para
E.164 é responsabilidade do adaptador de entrada; o banco só garante unicidade
do que foi gravado. Um `check` de formato entra junto.

### `conversations`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `clinic_id` | uuid NOT NULL | |
| `contact_id` | uuid NOT NULL | FK composta com `clinic_id` |
| `status` | enum `conversation_status` | ver §4 |
| `assigned_to` | uuid NULL | → **`clinic_members(clinic_id, user_id)`**, ver §7 |
| `last_message_at` | timestamptz NULL | Última mensagem, em qualquer direção |
| `last_inbound_at` | timestamptz NULL | Última mensagem **do paciente** |
| `last_read_at` | timestamptz NULL | Ver §8 |
| `version` | integer NOT NULL default 1 | Concorrência otimista, §9 |
| `created_at` / `updated_at` | timestamptz | |

- `unique (clinic_id, id)`
- Enquanto for uma conversa por contato: `unique (clinic_id, contact_id)`.
  **Esta constraint é a decisão reversível mais importante do desenho** —
  removê-la depois libera episódios sem tocar em mais nada.

**Não há `unread_count`.** Ver §8.

**Não há `patient_id` na conversa** — ele vive no contato. Duplicar aqui criaria
duas respostas possíveis para "quem é essa pessoa".

### `messages`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `clinic_id` | uuid NOT NULL | |
| `conversation_id` | uuid NOT NULL | FK composta com `clinic_id` |
| `direction` | enum `message_direction` | `inbound` \| `outbound` |
| `body` | text NOT NULL | `check (char_length(body) between 1 and 4096)` |
| `occurred_at` | timestamptz NOT NULL | Quando aconteceu **no canal**, não quando gravamos |
| `author_user_id` | uuid NULL | Quem escreveu, quando saiu da clínica. NULL em `inbound`. |
| `provider` | text NULL | Adaptador que trouxe. NULL quando registrada à mão. |
| `provider_message_id` | text NULL | Id no provedor |
| `delivery_status` | enum NULL | Só faz sentido em `outbound`; ver §13 |
| `created_at` | timestamptz | |

- `unique (clinic_id, provider, provider_message_id)` **parcial**, onde
  `provider_message_id is not null`.

> **Esta coluna precisa existir desde a primeira migration, mesmo sem provedor
> nenhum conectado.** Todo webhook de mensageria entrega duplicado — é
> at-least-once por contrato, não por defeito. Sem essa chave de deduplicação
> gravada desde o início, a primeira integração vai duplicar mensagem em
> produção e o conserto será backfill com dado já sujo.

- Sem `updated_at` e sem UPDATE: mensagem é fato consumado. A única coluna que
  muda depois é `delivery_status`, e ela justifica um UPDATE restrito.

### `conversation_events`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `clinic_id` | uuid NOT NULL | |
| `conversation_id` | uuid NOT NULL | FK composta |
| `type` | enum `conversation_event_type` | ver §14 |
| `actor_user_id` | uuid NULL | NULL = sistema (reabertura automática) |
| `payload` | jsonb NOT NULL default `'{}'` | De → para, ids relacionados |
| `occurred_at` | timestamptz NOT NULL default now() | |

Append-only: sem UPDATE, sem DELETE, nem via API nem via grant. É o que responde
"quem encerrou isso e quando".

---

## 4. Estados — três, não seis

Vocês sugeriram `new`, `open`, `waiting_patient`, `waiting_clinic`, `resolved`.
Analisando o fluxo real, **proponho três**, e explico o que aconteceu com os
outros.

| Estado | Significado operacional |
|---|---|
| `open` | A bola está com a clínica. Precisa de alguém. |
| `waiting_patient` | Fizemos a nossa parte. A bola está com o paciente. |
| `closed` | Por ora não há o que fazer. |

### O que virou derivação, não estado

**`new`** não é estado, é **`open` que ninguém assumiu ainda**
(`assigned_to IS NULL`). Guardar como estado cria a pergunta impossível: uma
conversa nova que alguém assumiu e ainda não respondeu é `new` ou `open`? Duas
pessoas responderiam diferente, e a fila passaria a mentir.

**`waiting_clinic`** é a mesma coisa que `open`. Do ponto de vista da fila, uma
conversa aberta **é** a vez da clínica. Um quarto estado com o mesmo significado
divide a fila sem acrescentar informação e produz o clássico: metade da equipe
usa um, metade usa o outro, e nenhum filtro fica confiável.

### O caso que realmente sobra — e por que ele não é estado

"Aguardando alguém de dentro" (a doutora precisa responder, o exame precisa ser
pedido) é real e não cabe em `open` sem poluir a fila. Mas ele tem **dono, prazo
e resolução próprios, independentes da conversa** — o pedido de exame continua
pendente mesmo se o paciente encerrar o assunto.

Isso é **Pendência**, o módulo seguinte. Modelar como estado de conversa é
exatamente transformar Conversation na lista de tarefas improvisada que vocês
pediram para evitar. Ver §10.

### State machine

```
                    ┌──────────── mensagem do paciente (automático) ──────────┐
                    │                                                          │
                    ▼                                                          │
   (contato novo) ──► open ──────── atendente marca ──────► waiting_patient ───┤
                       │                                          │            │
                       │ encerra                                  │ encerra    │
                       ▼                                          ▼            │
                     closed ◄─────────────────────────────────────┘            │
                       │                                                       │
                       └──── reabre (mensagem do paciente OU manual) ──────────┘
```

**Nenhum estado é terminal** — e essa é a diferença deliberada em relação à
máquina de estados de `appointments`, onde `completed`, `no_show` e `cancelled`
são finais. Um agendamento realizado não volta atrás; uma conversa sempre pode
receber outra mensagem. Fechar e travar perderia mensagem, que é o pior defeito
possível numa caixa de entrada.

**Reabertura por mensagem do paciente é automática**, feita no mesmo passo da
ingestão. Se dependesse de alguém clicar, uma resposta chegando num domingo
ficaria invisível até que alguém abrisse a conversa encerrada.

Transições ilegais: nenhuma, entre esses três. Mas a **regra vale no banco**,
como em `appointments`, para que nenhum caminho de escrita produza histórico
impossível, e é espelhada em `packages/shared`.

---

## 5. Fila, responsável e leitura são três eixos

Este é o ponto que vocês pediram para separar, e ele merece ser explícito
porque misturar os três é o erro mais comum em caixa compartilhada:

| Eixo | Coluna | Pergunta que responde |
|---|---|---|
| **STATUS** | `status` | De quem é a vez? |
| **RESPONSÁVEL** | `assigned_to` | Quem está cuidando? |
| **LEITURA** | `last_read_at` vs `last_message_at` | Alguém já olhou? |

São ortogonais: uma conversa pode estar `waiting_patient`, atribuída à Ana, e
não lida (o paciente respondeu e ninguém viu ainda).

### As visões da fila saem de combinações, não de estados novos

| Visão | Filtro |
|---|---|
| Novas | `status = open AND assigned_to IS NULL` |
| Minhas | `assigned_to = eu` (qualquer status aberto) |
| Em atendimento | `status = open AND assigned_to IS NOT NULL` |
| Aguardando paciente | `status = waiting_patient` |
| Não lidas | `last_message_at > coalesce(last_read_at, '-infinity')` |
| Encerradas | `status = closed` |

Seis visões úteis a partir de três estados. É o teste de que a modelagem está no
lugar certo: **as visões são consultas, não colunas**.

---

## 6. Relações e chaves

```
clinics ──┬─► contacts ──► conversations ──┬─► messages
          │      │                          └─► conversation_events
          │      └─► patients (opcional)
          ├─► patients
          ├─► clinic_members ◄── assigned_to / author_user_id
          └─► appointments ◄── conversation_events.payload
```

Todas as FKs entre entidades tenant-scoped são **compostas e tenant-first**, o
padrão já usado na agenda:

```sql
foreign key (clinic_id, contact_id)
  references public.contacts (clinic_id, id) on delete cascade
```

**Por que isso importa mais aqui do que em qualquer outro módulo:** verificação
de FK no PostgreSQL **ignora RLS**. Uma FK simples para `contacts(id)` aceitaria
um contato de outra clínica sem violar nenhuma policy. A FK composta torna a
referência cross-tenant impossível na estrutura — inclusive para `service_role`,
que é o único ator capaz de contornar RLS.

### Vínculo com agendamento

`conversation_events` com `type = 'appointment_linked'` e o `appointment_id` no
payload. **Não proponho coluna `appointment_id` em `conversations`**: uma
conversa produz vários agendamentos ao longo do tempo (marcou, remarcou, marcou
o retorno), e uma coluna guardaria só o último, apagando silenciosamente o
histórico que a recepção justamente quer consultar.

Se a consulta "quais conversas geraram este agendamento" ficar frequente, a
resposta é um índice em `payload->>'appointment_id'`, ou uma tabela de ligação
`conversation_appointments` — não uma coluna escalar.

---

## 7. Multi-tenant

Mesma filosofia da fundação e da agenda, sem exceção:

1. `clinic_id NOT NULL` em todas as quatro tabelas.
2. `unique (clinic_id, id)` em todas, para habilitar as FKs compostas.
3. Trigger `prevent_clinic_id_change` em todas.
4. RLS com `is_clinic_member(clinic_id)` em SELECT / INSERT / UPDATE.
5. Grants por `revoke-then-grant`, **sem `TRUNCATE` e sem `REFERENCES`**.
6. Nenhum cliente escolhe `clinic_id`: ele vem do `ClinicMembershipGuard`, do
   header validado no servidor, exatamente como hoje.

### `assigned_to` validado por FK, não por código

Este é o único ponto genuinamente novo, e tem solução elegante dentro do padrão
existente. `clinic_members` já tem `unique (clinic_id, user_id)`. Então:

```sql
foreign key (clinic_id, assigned_to)
  references public.clinic_members (clinic_id, user_id) on delete set null
```

Com isso, **atribuir uma conversa a alguém de outra clínica é estruturalmente
impossível** — não depende de a API lembrar de checar. Se o vínculo for
revogado, a conversa volta sozinha para a fila (`SET NULL`), que é o
comportamento correto: a pessoa saiu, o trabalho não pode ficar preso a ela.

O mesmo vale para `messages.author_user_id` e `conversation_events.actor_user_id`
— com uma ressalva: `ON DELETE SET NULL` neles apaga a autoria histórica. Para o
log de eventos, o melhor é `ON DELETE RESTRICT` no membership e desativar em vez
de remover, ou aceitar a perda de autoria conscientemente. **Este é um ponto que
quero decidir com vocês antes da migration.**

### DELETE: ausência de policy é negação

Nenhuma das quatro tabelas recebe policy de DELETE, seguindo o padrão. Conversa
não se apaga: encerra. Mensagem não se apaga: é registro do que aconteceu.

---

## 8. Leitura: por que não existe `unread_count`

Duas opções foram consideradas.

**Contador (`unread_count`).** Precisa incrementar na chegada e zerar na
abertura. Contador que sobe e desce em dois caminhos diferentes **sempre**
diverge — basta uma mensagem processada duas vezes, ou uma abertura concorrente.
E ele exige um UPDATE na conversa a cada mensagem.

**Par de timestamps.** `unread = last_message_at > coalesce(last_read_at, ...)`.
Não há nada para divergir: os dois campos são fatos, não acumuladores. E o
"quantas não lidas" que às vezes se quer sai de um `count(*)` na thread aberta,
onde o custo não incomoda.

**Proponho o par de timestamps.**

### Leitura é compartilhada, não por usuário

Numa clínica de duas ou três pessoas na mesma caixa, se a Ana leu, **a equipe
viu**. Marcar como não lida para o Bruno faria a fila mostrar trabalho que já
tem dono e já foi olhado.

Leitura por usuário (estilo Gmail) exigiria `conversation_reads(clinic_id,
conversation_id, user_id, last_read_at)`. É acréscimo puro — pode entrar depois
sem mexer no formato da conversa. Começar por lá seria pagar complexidade antes
de ter o problema.

---

## 9. Concorrência: dois atendentes

Quatro riscos foram levantados. Cada um tem uma defesa diferente, e nenhuma
delas é "a API toma cuidado".

### a) Dois assumem a mesma conversa

**UPDATE condicional, não read-then-write.** A tomada é:

```sql
update conversations
   set assigned_to = :eu, version = version + 1
 where clinic_id = :c and id = :id and assigned_to is null
returning *;
```

Zero linhas = alguém chegou antes. A API devolve **409 com o estado atual**, e a
tela mostra "Ana assumiu esta conversa" em vez de sobrescrever em silêncio.
Não precisa de version para este caso: a própria condição `assigned_to is null`
é o guarda.

### b) Transferência sobrescrita

`where assigned_to = :quem_eu_vi`. Se o responsável já mudou, a condição falha e
volta 409. Transferir "de X para Y" nunca vira "de qualquer um para Y".

### c) Mudança silenciosa de estado

Coluna `version`, incrementada por trigger em todo UPDATE. A API recebe a versão
que a tela viu e a usa na cláusula `where`. Divergência → **409 com o estado
atual**, no mesmo formato que a agenda já usa para conflito de horário. A
recepção já conhece esse padrão de "confirme, mudou algo".

### d) Mensagem na clínica errada

`messages.clinic_id` **nunca vem do cliente**. Ele é derivado da conversa no
próprio INSERT, e a FK composta `(clinic_id, conversation_id)` recusa qualquer
combinação inconsistente. Uma mensagem numa clínica errada não é um bug que
precisa ser evitado: é uma linha que o banco não aceita gravar.

Nada disso será implementado nesta fase — é o desenho a validar.

---

## 10. Relação com Pendências

O módulo Pendências vem depois. **Nada de `Task` agora.**

Eventos do Atendimento que provavelmente virarão pendência:

| Situação na conversa | Pendência provável |
|---|---|
| Paciente pediu para remarcar e não há horário agora | Retornar com opções, com prazo |
| Precisa enviar pedido de exame | Enviar documento, com responsável |
| Depende de resposta da profissional | Confirmar internamente |
| "Te ligo amanhã de manhã" | Acompanhamento agendado |
| Paciente sumiu depois de pedir orçamento | Retomar contato em N dias |

**A fronteira, dita de uma vez:** uma pendência tem **dono, prazo e resolução
próprios**, e sobrevive à conversa. O pedido de exame continua pendente mesmo
que o paciente encerre o assunto, e pode ser resolvido por outra pessoa que nem
leu a conversa.

Por isso `conversation.status` não ganha um estado por tipo de espera. Quando
Pendências existir, ela **consome os eventos** da §14 e cria tarefas ligadas à
conversa. A conversa continua respondendo só "de quem é a vez".

---

## 11. UX desktop — wireframe

Três colunas, no mesmo design system (navy, azul de ação, bordas finas, densidade alta).

```
┌────────┬───────────────────────┬─────────────────────────────┬──────────────────────┐
│        │  FILA                 │  THREAD                     │  CONTEXTO            │
│  side  │  ~320px               │  flex                       │  ~300px              │
│  bar   ├───────────────────────┼─────────────────────────────┼──────────────────────┤
│        │ [buscar contato/tel ] │ ┌─────────────────────────┐ │ ┌──────────────────┐ │
│ Hoje   │                       │ │ MB  Mariana Barros      │ │ │ MB Mariana Lima  │ │
│ Agenda │ Novas 3 · Minhas 2 ·  │ │     (11) 98765-4321     │ │ │ (11) 98765-4321  │ │
│ Aten.  │ Aguardando · Todas    │ │     ● Ana Souza         │ │ │ Unimed           │ │
│ Pacien.│                       │ │  [Transferir][Encerrar] │ │ └──────────────────┘ │
│        │ ┌───────────────────┐ │ └─────────────────────────┘ │                      │
│ GESTÃO │ │● MB Mariana  14:32│ │                             │ PRÓXIMA CONSULTA     │
│ Profis.│ │  Pode ser quinta? │ │        ┌──────────────────┐ │ 31/08 12:30          │
│ Serviç.│ │  ○ sem responsável│ │        │ Oi, preciso re…  │ │ Dra. Carla · Proced. │
│        │ ├───────────────────┤ │        │             14:28│ │                      │
│        │ │  JS João      13:0│ │        └──────────────────┘ │ HISTÓRICO            │
│        │ │  Obrigado!        │ │ ┌────────────────────┐      │ 26/08 Retorno        │
│        │ │  ◐ Ana · aguard.  │ │ │ Claro! Tenho quin… │      │ 12/08 Consulta       │
│        │ └───────────────────┘ │ │ Ana · 14:30        │      │                      │
│        │                       │ └────────────────────┘      │ [+ Novo agendamento] │
│        │                       │ ┌─────────────────────────┐ │ [  Vincular paciente]│
│        │                       │ │ composer (fase 2)       │ │                      │
└────────┴───────────────────────┴─────────────────────────────┴──────────────────────┘
```

**Coluna esquerda — a fila.** Busca por nome ou telefone. Filtros como abas
compactas com contagem **real** (derivada das consultas da §5 — nunca número
inventado, como já é regra na tela Hoje). Cada linha: indicador de não lida
(ponto azul), avatar com iniciais, nome do contato ou paciente, prévia da última
mensagem, horário, e o responsável quando houver.

**Centro — a thread.** Cabeçalho com contato, telefone, responsável e as ações
(`Assumir` quando livre, `Transferir` / `Encerrar` quando atribuída). Mensagens
alinhadas por direção — entrada à esquerda, saída à direita — com autoria e
horário nas de saída. Composer desabilitado e rotulado "disponível quando o
WhatsApp for conectado" na primeira versão, **pelo mesmo princípio da busca da
topbar**: campo que engole o que a pessoa digitou é pior que campo nenhum.

**Direita — o contexto.** É o que diferencia isto de um iframe do WhatsApp:
ficha do paciente, próxima consulta, histórico recente, e as duas ações que
fecham o ciclo (`Vincular paciente` / `Criar paciente`, `Novo agendamento`).
Sem paciente vinculado, esta coluna vira o formulário de vínculo.

**Estados vazios**, no padrão já estabelecido: fila vazia é faixa compacta
("Nenhuma conversa aberta"), não card de 200px.

## 11b. UX mobile

Três colunas não cabem. Navegação em pilha:

```
FILA  ──toque──►  THREAD  ──toque no cabeçalho──►  CONTEXTO (sheet)
  ◄──── voltar ────┘             ◄──── fechar ────┘
```

- Filtros viram um seletor horizontal rolável no topo.
- Ações da conversa saem do cabeçalho para uma barra fixa no rodapé, onde o
  polegar alcança.
- O contexto do paciente vira sheet, não coluna.
- Composer fixo no rodapé quando existir.

---

## 12. Relação com Patient e Appointment

**Conversa sem paciente é normal, não é erro.** Número desconhecido chega, entra
na fila, alguém atende. O vínculo é uma ação deliberada, nunca automática por
telefone parecido — casar por telefone sozinho pode expor a ficha de outra
pessoa, que é justamente o erro que este produto não pode cometer.

Dois caminhos, ambos a partir da coluna direita:

- **Vincular a existente** — busca por nome/telefone entre os pacientes da
  clínica, confirma, grava `contacts.patient_id` e emite `patient_linked`.
- **Criar a partir da conversa** — abre o formulário de paciente já preenchido
  com telefone e nome do canal, e vincula ao salvar.

Com paciente vinculado, a coluna direita mostra próxima consulta e histórico
reusando o que a tela Pacientes já faz.

**Agendar dentro do atendimento** abre o mesmo drawer de agendamento da agenda,
com o paciente pré-selecionado. Ao salvar, emite `appointment_linked`. Reusar o
drawer, e não fazer um formulário paralelo, é o que evita duas regras de conflito
que discordam entre si.

---

## 13. Desacoplar o provedor

O domínio **não conhece Meta, Evolution, nem WhatsApp**. Conhece canal e
adaptador.

```
   ┌──────────────────────────────────────────┐
   │  DOMÍNIO (o que este documento propõe)   │
   │  conversations · messages · events       │
   │  regras de estado, atribuição, vínculo   │
   └───────▲──────────────────────┬───────────┘
           │ porta de entrada     │ porta de saída
           │ IncomingMessage      │ OutboundMessage
   ┌───────┴──────────┐   ┌───────▼──────────┐
   │ adaptadores      │   │ adaptadores      │
   │ · manual (v1)    │   │ · manual (v1)    │
   │ · meta cloud     │   │ · meta cloud     │
   │ · evolution      │   │ · evolution      │
   └──────────────────┘   └──────────────────┘
```

**Porta de entrada.** Um DTO neutro — `{ channel, externalId, displayName?,
body, occurredAt, providerMessageId? }` — e um serviço de ingestão que faz
sempre a mesma coisa: acha ou cria o contato, acha ou cria a conversa, deduplica
por `(clinic_id, provider, provider_message_id)`, grava a mensagem, atualiza
`last_message_at` / `last_inbound_at`, reabre se estava `closed`, emite evento.
**Idempotente por construção**, porque todo provedor entrega duplicado.

**Porta de saída.** Uma interface com `send(message)`. Na v1 existe só a
implementação `manual`, que não envia nada e apenas registra o que foi dito por
fora.

### `channel = 'manual'` desde o primeiro dia

Esta é a proposta que menos se espera num módulo de WhatsApp, e é a que sustenta
o resto: permitir que a recepção **registre à mão** uma conversa que aconteceu
por telefone ou no balcão.

Três motivos:

1. **O módulo é útil sem provedor nenhum.** A clínica passa a ter registro de
   "quem falou o quê" já na primeira versão, e ligação telefônica é hoje metade
   do atendimento real.
2. **Prova a abstração antes de escolher fornecedor.** Se o domínio funciona com
   o canal manual, ele funciona com qualquer adaptador — e descobrimos isso
   antes de acoplar, não depois.
3. **Permite testar de ponta a ponta** sem webhook, sem QR code e sem número de
   teste.

---

## 14. Eventos para automação futura

`conversation_events.type`:

| Evento | Emitido quando | Quem vai consumir |
|---|---|---|
| `conversation_opened` | Contato novo ou reabertura | Pendências, métricas |
| `message_received` | Mensagem do paciente | Automação, SLA |
| `message_sent` | Mensagem da clínica | SLA de resposta |
| `assigned` | Alguém assumiu | Métricas por atendente |
| `unassigned` | Devolvida à fila | Fila |
| `transferred` | De X para Y | Auditoria |
| `status_changed` | Qualquer mudança | Fila, métricas |
| `patient_linked` | Contato vinculado | Ficha do paciente |
| `appointment_linked` | Agendamento criado a partir da conversa | Métricas de conversão |
| `closed` / `reopened` | Encerramento e retorno | Pendências |

Na v1 são **linhas numa tabela**, não um barramento. Ler o log é suficiente para
o histórico da conversa. Quando Automações existir, ela passa a observar essa
mesma tabela — e o formato já estará estável e com histórico real acumulado.

---

## 15. O que NÃO entra na primeira versão

Deliberadamente fora, para a v1 caber e ser avaliável:

- **Envio real de mensagem.** Composer visível e desabilitado, com o motivo dito.
- **Qualquer provedor concreto**: Meta, Evolution, webhook, QR, fila, worker.
- **Mídia** (imagem, áudio, documento, PDF de exame). Só texto.
- **Templates / HSM** e a janela de 24h da Meta.
- **Pendências / Task.**
- **Automações**, respostas automáticas, chatbot, IA.
- **SLA e temporizadores.**
- **Leitura por usuário** — leitura é compartilhada (§8).
- **Episódios** — uma conversa por contato (§3).
- **Grupos**, listas de transmissão, múltiplos números por clínica.
- **Busca dentro das mensagens** — exige full-text; a busca da v1 é por contato.
- **Ações em lote.**
- **Notificação push / som.**
- **Indicador de digitando, presença, confirmação de leitura do paciente.**
- **Edição ou exclusão de mensagem.**

---

## 16. Migrations que seriam necessárias depois

Seguindo a numeração e a divisão atuais (schema / rls / grants em arquivos
separados), **quando aprovado**:

| Arquivo | Conteúdo |
|---|---|
| `…_atendimento_schema.sql` | Enums (`conversation_channel`, `conversation_status`, `message_direction`, `conversation_event_type`, `message_delivery_status`), as 4 tabelas, `unique (clinic_id, id)`, FKs compostas, índices, triggers de `updated_at`, `prevent_clinic_id_change`, transição de status e `version` |
| `…_atendimento_rls.sql` | `enable row level security` nas 4, policies com `is_clinic_member`, **sem policy de DELETE**, e `conversation_events` sem UPDATE |
| `…_atendimento_grants.sql` | `revoke all from public, anon, authenticated` e grants mínimos. Sem `TRUNCATE`, sem `REFERENCES`. `messages` sem DELETE; `conversation_events` só `select, insert` |

Índices que já dá para antecipar:

```sql
conversations (clinic_id, status, last_message_at desc)   -- a fila
conversations (clinic_id, assigned_to, last_message_at desc) -- "minhas"
messages (clinic_id, conversation_id, occurred_at)        -- a thread
contacts (clinic_id, channel, external_id)                -- ingestão (unique)
conversation_events (clinic_id, conversation_id, occurred_at) -- histórico
```

---

## 17. Endpoints que seriam necessários depois

Todos sob `AuthGuard` + `ClinicMembershipGuard`, com `clinic_id` vindo do
servidor. Nenhum aceita `clinicId` no corpo.

| Método | Rota | Observação |
|---|---|---|
| `GET` | `/api/conversations` | Filtros `status`, `assignedTo`, `unread`, `q`; paginado desde o começo — a fila cresce sem teto, ao contrário de profissionais e serviços |
| `GET` | `/api/conversations/:id` | Conversa + contato + paciente |
| `GET` | `/api/conversations/:id/messages` | Paginado, ordem cronológica |
| `POST` | `/api/conversations/:id/read` | Grava `last_read_at` |
| `POST` | `/api/conversations/:id/assign` | Assumir. UPDATE condicional; 409 se já tem dono |
| `POST` | `/api/conversations/:id/transfer` | Condicional no responsável esperado |
| `POST` | `/api/conversations/:id/release` | Devolve à fila |
| `PATCH` | `/api/conversations/:id/status` | Com `version`; 409 com estado atual |
| `POST` | `/api/conversations/:id/link-patient` | Vincula existente |
| `POST` | `/api/conversations/:id/messages` | v1: só registro manual |
| `POST` | `/api/conversations` | Abre conversa manual a partir de um telefone |
| `GET` | `/api/conversations/:id/events` | Histórico de quem fez o quê |

**Contagens da fila:** um `GET /api/conversations/counts` devolvendo os números
das abas numa chamada. Sem ele, a tela faria seis consultas para desenhar seis
abas — e a §11 do `architecture.md` já mostra o que ida e volta a mais custa
nesta infraestrutura.

---

## 18. Testes de segurança a escrever

No estilo do `agenda-isolation.test.ts` — JWT real de cada usuário, quem
responde é o RLS:

**Isolamento**

1. A lista conversas → só as da clínica A.
2. A busca conversa de B por id → 404 **idêntico** ao de um UUID inexistente
   (mesmo status, mesmo corpo, sem `Location`) — não vazar existência.
3. A tenta assumir conversa de B → 404.
4. A tenta ler mensagens de conversa de B → 404, corpo vazio.
5. A tenta INSERT de mensagem com `conversation_id` de B → `42501`.
6. A tenta mover conversa para a clínica B → recusado por `WITH CHECK` + trigger.
7. **Nem `service_role` cria conversa com `contact_id` de outra clínica** →
   espera `23503`. É o teste que prova a FK composta.
8. Idem para `messages` e `conversation_events`.
9. Cliente anônimo → nada, em todas as quatro tabelas.
10. `X-Clinic-Id` forjado da clínica B com JWT de A → negado, e a asserção
    verifica que **nenhum campo de dado de B aparece no corpo** — não basta o
    status.

**Atribuição**

11. Atribuir a um `user_id` que não é membro da clínica → recusado pela FK.
12. Revogar o membership → conversa volta para a fila, não fica presa.

**Concorrência**

13. Dois `assign` simultâneos na mesma conversa → um 200, um 409. Nunca dois 200.
14. `transfer` com responsável desatualizado → 409, sem sobrescrever.
15. `PATCH status` com `version` velha → 409 com o estado atual.

**Ingestão**

16. Mesma mensagem entregue duas vezes (mesmo `provider_message_id`) → uma linha
    só, e a segunda não altera `last_message_at`.
17. Mensagem para conversa `closed` → reabre e emite `reopened`.

**Log**

18. UPDATE e DELETE em `conversation_events` → negados por ausência de policy,
    inclusive para quem é membro.

---

## Decisões que preciso de vocês antes de escrever qualquer migration

1. **`contacts` separado** ou telefone direto na conversa? (§3 — recomendo separado)
2. **Três estados** em vez dos cinco sugeridos? (§4 — recomendo três)
3. **Uma conversa por contato** (`unique (clinic_id, contact_id)`) ou episódios desde já? (§3 — recomendo uma)
4. **Leitura compartilhada** ou por usuário? (§8 — recomendo compartilhada)
5. **`channel = 'manual'` na v1**? (§13 — recomendo sim; é o que torna o módulo útil sem provedor)
6. **Autoria histórica ao remover membership**: `SET NULL` e perde autoria, ou `RESTRICT` e membership só desativa? (§7 — sem recomendação forte, quero a opinião de vocês)
