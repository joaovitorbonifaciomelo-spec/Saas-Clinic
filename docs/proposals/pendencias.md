# Proposta técnica — Módulo Pendências

> **Status: proposta. Nada implementado.** Nenhuma migration, SQL, endpoint,
> componente ou teste foi escrito nesta rodada.
>
> Escrita depois de ler o schema real — `patients`, `appointments`,
> `conversations`, `clinic_members`, `profiles`, os helpers de RLS, os grants e
> o padrão de RPC do Atendimento. As decisões abaixo citam o que existe hoje,
> não uma convenção paralela.

---

## 1. O problema real

A recepção da clínica carrega, o dia inteiro, um conjunto de coisas que
*precisam ser feitas depois*: retornar para alguém, tentar um encaixe quando
abrir horário, cobrar um documento, acompanhar uma solicitação, lembrar de algo
ligado a um agendamento.

Hoje essas coisas moram em memória, em conversa de WhatsApp deixada aberta de
propósito, em papel, ou em "depois eu faço".

Todos esses lugares têm o mesmo defeito: **a informação depende de a pessoa
certa lembrar, no momento certo.** Quando ela falta, sai de férias ou
simplesmente tem um dia cheio, a tarefa desaparece sem deixar rastro — e o
paciente é quem descobre.

Pendências existe para tirar isso da memória. Não para organizar trabalho em
abstrato: para que uma ação combinada com um paciente sobreviva à pessoa que a
combinou.

---

## 2. O que pertence ao domínio

Uma pendência é **uma ação interna que alguém da clínica precisa executar**.

Três propriedades a definem:

1. **Tem dono ou pode ter** — alguém é responsável, ou está na fila geral.
2. **Tem momento ou pode ter** — um prazo, ou "assim que possível".
3. **Sobrevive ao contexto que a originou** — encerrar a conversa não conclui a
   tarefa; cancelar o agendamento não apaga a tarefa.

A terceira é a que justifica o módulo existir. Se a tarefa morresse junto com a
conversa, bastaria um campo de anotação na conversa.

---

## 3. O que não pertence

Não é Trello, kanban, gerenciador de projetos, calendário paralelo, CRM,
automação, fila de mensagens, prontuário nem financeiro.

Três exclusões merecem o porquê, porque são as que a pressão de uso vai tentar
furar:

- **Não é lista genérica de tarefas da clínica.** "Comprar papel toalha" não é
  pendência. A partir do momento em que for, a tela deixa de responder "o que
  falta fazer pelos pacientes" e passa a responder "o que falta fazer", que é
  uma pergunta sem dono. Ver decisão **D1**.
- **Não modifica as entidades que referencia.** Concluir uma pendência não
  confirma um agendamento nem encerra uma conversa. O módulo observa; não
  comanda.
- **Não é canal de comunicação.** Pendência não manda mensagem. Se a ação é
  "mandar mensagem", quem manda é o Atendimento, e a pendência é o lembrete de
  fazê-lo.

Fora da v0.1, explicitamente: recorrência, RRULE, templates, notificações
(push/e-mail/WhatsApp/badge em tempo real), automações, e a integração com a
página Hoje.

---

## 4. Modelo proposto

Duas tabelas.

| Tabela | Papel |
|---|---|
| `tasks` | estado atual da pendência |
| `task_events` | histórico append-only do que aconteceu com ela |

A justificativa da segunda está em **§11**; ela não é simetria decorativa com o
Atendimento.

Nomenclatura: `tasks` em inglês, como todo o schema (`conversations`,
`appointments`, `patients`). "Pendências" é o nome do produto, na UI.

---

## 5. Campos

### `tasks`

| Campo | Tipo | Nota |
|---|---|---|
| `id` | uuid pk | |
| `clinic_id` | uuid **not null** | FK → `clinics(id)` `on delete cascade` |
| `title` | text **not null** | `char_length(btrim(title)) between 3 and 200` |
| `description` | text null | `<= 2000`, mesmo teto de `appointments.notes` |
| `status` | `task_status` **not null** default `'open'` | ver §6 |
| `assigned_to` | uuid null | FK composta → `clinic_members(clinic_id, user_id)` |
| `due_at` | timestamptz null | ver **D4** |
| `patient_id` | uuid null | FK composta → `patients(clinic_id, id)` |
| `conversation_id` | uuid null | FK composta → `conversations(clinic_id, id)` |
| `appointment_id` | uuid null | FK composta → `appointments(clinic_id, id)` — **exige migration aditiva, ver R1** |
| `created_by` | uuid null | → `auth.users(id)` `on delete set null` |
| `completed_by` | uuid null | idem |
| `completed_at` | timestamptz null | carimbado pelo servidor |
| `cancelled_by` | uuid null | idem |
| `cancelled_at` | timestamptz null | carimbado pelo servidor |
| `version` | integer **not null** default 1, `check (version > 0)` | ver §10 |
| `created_at` / `updated_at` | timestamptz **not null** default now() | |

Mais `constraint tasks_clinic_id_id_key unique (clinic_id, id)`, como em todas
as outras tabelas do projeto — é o que permite que outra tabela aponte para
`tasks` tenant-first no futuro.

**Não existem** nesta lista, e é deliberado: `priority` (**D11**), `task_type`
(**D12**), `deleted_at` (**D10**), `overdue` (**D3**), `patient_name_snapshot`
(**R2**).

### `task_events`

Mesma forma que `conversation_events`, que já provou funcionar:

| Campo | Nota |
|---|---|
| `id`, `clinic_id`, `task_id` | FK composta → `tasks(clinic_id, id)` `on delete cascade` |
| `event_type` | enum, ver §11 |
| `actor_user_id` | → `auth.users(id)` `on delete set null` |
| `actor_name_snapshot` | text, `1..120` |
| `actor_role_snapshot` | `clinic_role` |
| `metadata` | jsonb `not null default '{}'`, objeto, `<= 2048 bytes` |
| `created_at` | timestamptz |

O snapshot de nome fica **aqui**, não na `tasks` — ver **D16**.

---

## 6. Estados — três

```
open ──► completed
  │  ◄──────┘  (reabrir)
  │
  └──► cancelled
       ◄──┘     (reabrir)
```

`open`, `completed`, `cancelled`. Nada mais.

**Concordo com a direção.** `new`, `in_progress`, `waiting`, `overdue`, `today`
e `upcoming` não são estados da pendência — são recortes de uma lista:

| Recorte | Derivação |
|---|---|
| Atrasadas | `status = 'open' and due_at < now()` |
| Hoje | `status = 'open'` e `due_at` dentro do dia **no fuso da clínica** |
| Próximas | `status = 'open' and due_at > fim do dia de hoje` |
| Sem prazo | `status = 'open' and due_at is null` |
| Minhas | `status = 'open' and assigned_to = auth.uid()` |
| Sem responsável | `status = 'open' and assigned_to is null` |
| Concluídas | `status = 'completed'` |

`in_progress` merece um parágrafo, porque é o que mais se pede: ele parece
informação e quase nunca é. Quem "começou" uma ligação que não completou não
mudou o mundo; a pendência continua pendente. O estado só passaria a valer se
existisse alguém esperando por ele — e não existe na v0.1.

---

## 7. Invariantes

1. **`clinic_id` é imutável.** Trigger, como em `patients` (migration 0005).
   Uma pendência não muda de clínica.
2. **Pelo menos um contexto** — `patient_id`, `conversation_id` ou
   `appointment_id` não nulo. Ver **D1**.
3. **`created_by` vem de `auth.uid()`**, nunca do cliente. Carimbado por
   trigger/RPC no servidor.
4. **`completed_at`/`completed_by` existem se e somente se `status =
   'completed'`.** Mesma regra para `cancelled_*`. Um CHECK garante os dois
   sentidos — é o que impede uma tarefa reaberta de continuar carregando a
   marca de concluída.
5. **`due_at` não tem restrição de futuro.** Ao contrário de
   `messages.occurred_at`, que rejeita futuro porque descreve um fato passado,
   `due_at` descreve uma intenção — e criar hoje uma pendência com prazo de
   ontem é legítimo (registrar algo que já deveria ter sido feito).
6. **Coerência de contexto verificada só na criação**, nunca depois. Ver **D13**.
7. **Todas as FKs de contexto são tenant-first e compostas.** Cross-tenant
   continua estruturalmente impossível, e não por confiança na aplicação.

---

## 8. Relações

### Por que as FKs são compostas

`(clinic_id, patient_id) → patients(clinic_id, id)`, e não
`patient_id → patients(id)`. A verificação de FK **ignora RLS**: uma FK simples
aceitaria alegremente o `patient_id` de outra clínica. A chave composta torna a
mistura impossível no nível do catálogo. É o padrão já aplicado em
`appointments` e `conversations`.

### `ON DELETE` de cada uma — lido do schema, não presumido

| FK | Regra | Por quê |
|---|---|---|
| `clinic_id → clinics(id)` | `cascade` | raiz do tenant |
| `(clinic_id, assigned_to) → clinic_members(clinic_id, user_id)` | `set null (assigned_to)` | tirar alguém da clínica **não pode** travar a remoção nem apagar a tarefa; ela volta para a fila geral |
| `(clinic_id, patient_id) → patients(clinic_id, id)` | `set null (patient_id)` | `patients` **tem** DELETE real (policy `patients_delete_admin`); ver **R2** |
| `(clinic_id, conversation_id) → conversations(clinic_id, id)` | `set null (conversation_id)` | preserva o princípio "a tarefa sobrevive ao contexto" |
| `(clinic_id, appointment_id) → appointments(clinic_id, id)` | `set null (appointment_id)` | idem |
| `created_by`, `completed_by`, `cancelled_by → auth.users(id)` | `set null` | mesmo tratamento de `appointments.created_by` |

> **A armadilha do `SET NULL` composto vale aqui igual.** `on delete set null`
> **sem lista de colunas anula todas as colunas da FK**, inclusive `clinic_id`,
> que é `not null` — a remoção falharia com violação de not-null e bloquearia
> justamente o que se queria permitir. A forma correta é
> `on delete set null (assigned_to)`, disponível desde o PostgreSQL 15; o
> projeto roda PG 17.

**Verificado no schema atual:** `conversations` e `appointments` **não possuem
policy nem grant de DELETE** — não há hard delete pela API. `patients`
**possui** (admin). Então o único `SET NULL` que dispara na prática hoje é o de
`patient_id` e o de `assigned_to`. Os outros dois são defesa contra um futuro em
que exclusão passe a existir, e custam nada.

### `patient_id` + `conversation_id`: por que os dois

A pergunta do briefing era se guardar `patient_id` quando a conversa já o tem
não seria duplicação. **Não é**, e a distinção importa:

- `conversation.patient_id` responde *"com quem estamos falando"*.
- `task.patient_id` responde *"sobre quem é esta ação"*.

Coincidem quase sempre, mas são afirmações diferentes, e o vínculo da conversa
**muda depois** — o Atendimento suporta vincular, desvincular e trocar paciente
com ação explícita (migration 0020). Se a tarefa resolvesse o paciente por join,
desvincular a conversa amanhã apagaria retroativamente o sujeito de uma tarefa
criada hoje. Isso é reescrever história.

Ver **D13** para o tratamento de coerência.

### `appointment_id`: por que aqui é diferente do Atendimento

A decisão 12 do Atendimento recusou `conversations.appointment_id` — e a
recusa **não se aplica aqui**, por um motivo de cardinalidade, não de gosto:

> Uma conversa produz **vários** agendamentos ao longo do tempo (marcou,
> remarcou, marcou o retorno). Uma coluna guardaria só o último.

Uma pendência trata de **uma** ação. "Solicitar o exame antes da consulta do dia
12" refere-se a um agendamento específico, e um só. A coluna é o modelo certo
aqui exatamente pela razão que a tornava errada lá.

---

## 9. Ciclo de vida

```
                 criar
                   │
                   ▼
   ┌──────────► open ──────────┐
   │             │             │
   │ reabrir     │ concluir    │ cancelar
   │             ▼             ▼
   └───── completed        cancelled ─────┐
                   ▲                      │
                   └──── reabrir ─────────┘
```

Transições permitidas: `open→completed`, `open→cancelled`,
`completed→open`, `cancelled→open`. Proibidas: `completed→cancelled` e
`cancelled→completed` diretas — quem errou reabre primeiro, e o caminho fica
legível no histórico.

**Reabrir é permitido, e recomendado** (**D8**). Sem isso, um clique errado é
permanente, e a resposta da equipe a um sistema que não perdoa é parar de usá-lo.

Ao reabrir, `completed_at`/`completed_by` (ou `cancelled_*`) voltam a `NULL` — o
invariante 4 exige. **A informação de que já esteve concluída não se perde**:
fica no `task_events`. Esse é o argumento mais concreto a favor da tabela de
eventos, e está detalhado em §11.

Concluir ou cancelar **não altera nada fora da tarefa**: nem status do
agendamento, nem status da conversa. E o contrário também: cancelar um
agendamento **não** cancela a pendência ligada a ele — ela continua aberta, e a
UI mostra que o agendamento relacionado foi cancelado. Concordo integralmente
com a direção do briefing aqui: acoplar os dois transformaria uma decisão de
agenda numa decisão sobre trabalho humano que ninguém tomou.

---

## 10. Concorrência

**Mesmo padrão já aprovado em `conversations`** — `version` +
`expected_version` + RPC atômica + 409 na API.

O cenário do briefing é real: Maria conclui enquanto João muda o prazo. Sem
proteção, o último UPDATE vence em silêncio e uma das duas ações desaparece sem
que ninguém saiba.

O contrato, idêntico ao do Atendimento:

- A API **nunca** faz `SELECT version` seguido de `UPDATE`. `expected_version` é
  obrigatório e vem do cliente, que o recebeu na leitura.
- Toda mudança de estado passa por RPC `security definer` com
  `set search_path = ''`.
- Retorno uniforme `{outcome, task}` com `outcome ∈ {ok, conflict, not_found}`,
  traduzido pela API em `200 | 409 | 404`.
- `tasks` **não recebe policy de UPDATE nem grant de UPDATE** para
  `authenticated`. Duas camadas dizendo a mesma coisa, e — como registrado no
  Atendimento — a ausência de policy é o que impede que um grant acidental
  reabra o caminho.
- `task_assign` usa a trava extra `and assigned_to is null`, como
  `conversation_assign`: duas pessoas nunca recebem sucesso no mesmo assign,
  ainda que a versão coincida por outro caminho.

`version` é incrementada por trigger, e **seletivamente** — mudança de
`updated_at` sozinha não conta como alteração concorrente.

---

## 11. Auditoria — recomendação: `task_events` desde a v0.1

O briefing pede a comparação. Ela é real, e a resposta não é "consistência com o
Atendimento".

**Opção A — só campos.** `created_by`, `completed_by/at`, `cancelled_by/at`
respondem as quatro perguntas mínimas. Custo quase zero.

**Opção B — `task_events` append-only.** Uma tabela, seu RLS, seus grants, seu
trigger de snapshot, seus índices.

**Recomendo B**, por três razões em ordem de peso:

1. **Reabrir exige.** Reabrir precisa limpar `completed_at`/`completed_by` (do
   contrário o invariante 4 quebra e a linha passa a mentir). Sem eventos, o
   fato de que a tarefa **já esteve concluída** simplesmente deixa de existir.
   A opção A e a decisão de permitir reabrir são incompatíveis: escolher A é
   escolher terminalidade, ou escolher que reabrir apague história.
2. **Prazo e responsável são exatamente onde a discussão acontece.** As perguntas
   que uma clínica de verdade faz não são "quem criou" — são *"quem mudou o
   prazo disso?"* e *"por que isso saiu comigo?"*. Campos atuais não respondem
   nenhuma das duas. É a razão de ser do módulo: coisas não desaparecerem em
   silêncio.
3. **O custo marginal é baixo porque o padrão já existe.** `conversation_events`
   está escrito, testado e documentado — trigger de snapshot de ator, teto de
   `metadata`, RLS, grants. Não é invenção; é repetição de algo que já passou por
   revisão.

Vocabulário de eventos proposto, deliberadamente curto:

```
created · assigned · transferred · released · due_changed
completed · cancelled · reopened
```

Não incluo `title_changed`/`description_changed`: são edição de texto, não
mudança de compromisso, e inflariam a tabela sem responder pergunta operacional.

**Os campos atuais continuam existindo junto com os eventos.** Não é redundância:
a lista precisa de "quem concluiu" sem join, e o histórico precisa de "o que
aconteceu" sem varrer. Mesma divisão de `conversations`, que tem
`last_message_at` **e** eventos.

---

## 12. RLS e multi-tenant

Padrões já aprovados, sem exceção:

| Item | Regra |
|---|---|
| `SELECT` | `public.is_clinic_member(clinic_id)` em `tasks` e `task_events` |
| `INSERT` | sem policy — criação só por RPC |
| `UPDATE` | **sem policy** — ver §10 |
| `DELETE` | **sem policy** — ver **D10** |
| `anon` / `PUBLIC` | zero, em tabela e em função |
| `clinic_id` | imutável por trigger |
| `created_by` | de `auth.uid()`, nunca do cliente |
| API normal | **sem `service_role`**, sem bypass de RLS |
| Cross-tenant | 404 idêntico a inexistente, non-disclosure |

As funções auxiliares são as que já existem: `is_clinic_member`,
`has_clinic_role`, `current_actor_snapshot`, `clinic_member_directory`. Nenhuma
função nova de membership.

---

## 13. Grants

Regra permanente do projeto, registrada em `architecture.md`: **nunca
`GRANT ALL`.** Lista positiva explícita.

```
authenticated:  select em tasks, task_events. Nada mais.
                execute nas RPCs de controle. Nada mais.
anon, public:   nada, em nenhuma tabela e em nenhuma função.
service_role:   select, insert, update, delete — sem truncate,
                references ou trigger.
```

> **Armadilha conhecida, e que já mordeu duas vezes** (migrations 0006 e 0014):
> `supabase db push` roda com um papel de login **sem** default privileges, e as
> tabelas nascem **sem grant nenhum**, inclusive para `service_role`. A migration
> de grants é obrigatória e o `verify:privileges` precisa rodar logo após o push.

Revogações por privilégio nomeado, nunca `revoke all` — `revoke all` derrubaria
também os quatro que devem ficar, e o resultado passaria a depender da ordem das
instruções.

---

## 14. UX conceitual — `/pendencias`

Não é kanban. É uma lista operacional que responde "o que falta fazer" em um
olhar.

```
┌──────────────────────────────────────────────────────────────┐
│  Pendências                              [ + Nova pendência ] │
├──────────────────────────────────────────────────────────────┤
│  Atrasadas 3 │ Hoje 5 │ Próximas │ Minhas │ Sem responsável   │
│  Sem prazo 2 │ Concluídas                                     │
├──────────────────────────────────────────────────────────────┤
│  ● Ligar sobre encaixe de quinta                              │
│    Maria Silva · ontem 14:00 · Ana · Atendimento    [Concluir]│
│  ○ Solicitar exame antes da consulta                          │
│    João Souza · hoje 17:00 · sem responsável · Agenda         │
└──────────────────────────────────────────────────────────────┘
```

**Nenhuma visão é redundante**, e vale dizer por quê, porque à primeira vista
"Atrasadas ⊂ Hoje" parece plausível:

- **Atrasadas** e **Hoje** são disjuntas por construção (`due_at < agora` vs.
  `due_at` no restante do dia). Separadas porque exigem reações diferentes:
  atrasada é dívida, hoje é plano.
- **Sem prazo** é a única que não aparece em nenhuma das outras. Se ela virasse
  uma aba escondida, o módulo recriaria exatamente o problema que veio resolver
  — tarefa que some. **Concordo com a direção do briefing: ela não pode ser
  escondida**, e proponho que o contador apareça mesmo quando zero.
- **Minhas** e **Sem responsável** cortam por dono, não por tempo; cruzam-se com
  as outras e não substituem nenhuma.

Contadores em todas as abas: sem número, a aba não informa nada antes do clique.

**Ação rápida `Concluir` direto na linha** — é a operação mais frequente e não
deve custar uma navegação. Ao clicar no item, drawer com descrição, contexto
completo e histórico.

Criação rápida com atrito mínimo: **título, prazo, responsável**. Quando criada
de outro módulo (Atendimento, Paciente, Agendamento), o contexto vem
pré-selecionado e não é digitado. O modelo suporta isso hoje; a integração não é
v0.1.

### Sobre `description` (§28 do briefing)

`description` guarda **instrução operacional** — "Ligar para o paciente sobre o
horário" —, não conteúdo clínico. O banco não tem como entender semântica de
texto, então isso é regra de produto: fica registrada aqui, no placeholder do
campo e na documentação. O teto de 2000 caracteres ajuda a sinalizar a intenção,
mas não a garante.

---

## 15. Consultas principais

Todas escopadas por `clinic_id`, sempre. Ordenação padrão: `due_at asc nulls
last, created_at asc` — o mais urgente primeiro, sem prazo por último.

```
fila por prazo       clinic_id + status='open'  → ordena por due_at
atrasadas            clinic_id + status='open' + due_at < :agora
hoje                 clinic_id + status='open' + due_at entre :inicio e :fim
minhas               clinic_id + assigned_to=:uid + status='open'
sem responsável      clinic_id + assigned_to is null + status='open'
por paciente         clinic_id + patient_id
por conversa         clinic_id + conversation_id
por agendamento      clinic_id + appointment_id
histórico            clinic_id + task_id, ordena por created_at
```

> **"Hoje" depende do fuso da clínica, não do servidor.** `clinics.timezone`
> existe (IANA, validado por trigger) e a API já tem o decorator
> `@ActiveClinicTimezone()` em uso no módulo de agendamentos. O intervalo do dia
> precisa ser calculado nesse fuso e enviado como dois `timestamptz` — a
> consulta permanece um range simples e continua usando índice. Ver **R3**.

Paginação por keyset, como em `conversations`, com a terceira ramificação
(`due_at is null`) tratada explicitamente — é a que costuma ser esquecida.

---

## 16. Índices propostos

Cinco. Cada um existe por uma consulta da lista acima, e nenhum por precaução.

| Índice | Serve |
|---|---|
| `(clinic_id, status, due_at asc nulls last, id)` | fila principal, atrasadas, hoje, próximas — todas são recortes do mesmo range |
| `(clinic_id, assigned_to, status, due_at)` **where** `assigned_to is not null` | "Minhas". Parcial porque "sem responsável" não se beneficia dele |
| `(clinic_id, patient_id)` **where** `patient_id is not null` | futura aba no contexto do paciente |
| `(clinic_id, conversation_id)` **where** `conversation_id is not null` | pendências abertas de uma conversa |
| `(clinic_id, appointment_id)` **where** `appointment_id is not null` | pendências de um agendamento |

Mais `(clinic_id, task_id, created_at)` em `task_events`, para o histórico.

**Não proponho** índice para "sem responsável" (`assigned_to is null`): o
primeiro índice já filtra por `clinic_id + status`, e o volume dentro de uma
clínica não justifica um índice parcial dedicado. Se a fila geral crescer a
ponto de doer, ele é aditivo.

Os três de contexto são **parciais** de propósito: a maioria das linhas terá
nulo em pelo menos dois deles, e indexar nulos custaria espaço sem servir
consulta nenhuma.

---

## 17. Riscos encontrados lendo o schema atual

### R1 — `appointments` não tem `unique (clinic_id, id)` · **bloqueante**

Seis tabelas têm a chave composta — `patients`, `professionals`, `services`,
`conversations`, `messages`, `conversation_events`. **`appointments` não tem.**

Consequência direta: a FK tenant-first
`(clinic_id, appointment_id) → appointments(clinic_id, id)` **não pode ser
criada hoje**. O PostgreSQL exige um índice único sobre exatamente as colunas
referenciadas.

Alternativas, e por que só uma serve:

- FK simples `appointment_id → appointments(id)` — **recusada**: a verificação
  de FK ignora RLS, e isso aceitaria um agendamento de outra clínica.
- Sem FK, validando por trigger — **recusada**: troca uma garantia do catálogo
  por disciplina de aplicação.
- **Adicionar `constraint appointments_clinic_id_id_key unique (clinic_id, id)`**
  — aditivo, alinha `appointments` com as outras seis, não quebra nada e é
  barato. **Recomendado**, como primeiro passo da migration.

Vale notar que isso não é dívida criada por Pendências: é uma inconsistência que
já existe no schema e que este módulo apenas foi o primeiro a encontrar.

### R2 — `patients` tem DELETE real

A policy `patients_delete_admin` permite hard delete por admin, e o grant de
DELETE para `authenticated` existe. Um paciente **com** agendamento está
protegido (`appointments.patient_fk` é `on delete restrict`), mas um paciente
**sem** agendamento pode ser apagado.

Com `set null (patient_id)` a tarefa sobrevive e perde o sujeito: sobra "Ligar
para confirmar" sem dizer para quem.

- `restrict` resolveria, mas faria uma pendência cancelada de meses atrás
  bloquear a exclusão de um cadastro — efeito colateral desproporcional.
- Um `patient_name_snapshot` resolveria a legibilidade, ao custo de um campo que
  na prática quase nunca seria lido.

**Recomendo `set null (patient_id)` e aceitar a perda**, porque o caso é raro
(paciente sem nenhum agendamento, apagado por admin, com pendência viva) e o
evento `created` guarda o `patient_id` original em `metadata`, o que permite
reconstruir o vínculo se algum dia importar. Fica registrado como custo aceito,
não como descuido.

### R3 — "Hoje" e "Atrasada" dependem do fuso da clínica

`now()` no banco é UTC. Uma pendência para "hoje às 18h" em São Paulo vira
21h UTC; um corte de dia feito em UTC classificaria errado tudo que cai entre
21h e meia-noite local — justamente o fim do expediente, onde as pendências se
acumulam.

A infraestrutura existe (`clinics.timezone`, `@ActiveClinicTimezone()`). O risco
é esquecer de usá-la e descobrir pelo relato de uma recepcionista de que "a
tarefa sumiu de Hoje". Deve virar teste explícito, com clínica em fuso diferente
do servidor.

### R4 — `overdue` calculado no cliente diverge do servidor

Se o frontend classificar "atrasada" com o relógio do navegador, um computador
com hora errada mostra uma fila diferente da real. A classificação deve vir de
consulta ao servidor, não de comparação em JavaScript.

### R5 — `appointments` não tem `version`

`conversations` tem controle otimista; `appointments` não. Pendências vai
introduzir o segundo uso do padrão. Não é problema para este módulo — é uma
assimetria do produto que vale registrar, porque um dia alguém vai perguntar por
que a agenda não protege contra edição simultânea.

---

## 18. Decisões abertas — precisam da sua escolha

| # | Questão | Minha recomendação |
|---|---|---|
| **A1** | Contexto obrigatório: aplicar CHECK na v0.1? | **Sim**, ver D1 — mas leia a ressalva, é a decisão de maior risco de estar errada |
| **A2** | `task_events` na v0.1, ou adiar para v0.2? | **v0.1**, ver §11. É a decisão mais cara da proposta |
| **A3** | Reabrir: qualquer membro, ou só admin/autor? | **Qualquer membro** na v0.1; RBAC fino não se justifica ainda |
| **A4** | Editar `title`/`description` depois de criada? | **Sim**, sem evento — é correção de texto, não mudança de compromisso |
| **A5** | Adicionar `appointments_clinic_id_id_key`? | **Sim** — sem isso R1 bloqueia `appointment_id` |

---

## 19. Recomendações explícitas

### Onde concordo com a sua direção

| Ref | Decisão | |
|---|---|---|
| **D2** | Três estados: `open`, `completed`, `cancelled` | ✅ concordo |
| **D3** | `overdue` derivado, nunca armazenado | ✅ concordo |
| **D4** | `due_at` opcional, com "Sem prazo" visível | ✅ concordo — obrigar produz prazo falso, e prazo falso destrói o sinal de "Atrasadas", que é o mais valioso da tela |
| **D5** | `assigned_to` nullable, FK composta, SET NULL seletivo | ✅ concordo |
| **D9** | `version` + `expected_version` + RPC + 409 | ✅ concordo |
| **D10** | Sem DELETE — só concluir ou cancelar | ✅ concordo |
| **D11** | Sem `priority` | ✅ concordo — prazo, atraso e responsável já ordenam, e escala de prioridade em equipe pequena converge para "tudo urgente" em semanas |
| **D12** | Sem `task_type` | ✅ concordo — enum fechado cedo vira lista arbitrária, e nenhum comportamento do sistema dependeria dele hoje |
| **D14** | Recorrência fora da v0.1 | ✅ concordo |
| **D15** | Cancelar agendamento não apaga pendência | ✅ concordo |
| **D17** | Notificações fora da v0.1 | ✅ concordo |

### Onde acrescento ou divirjo

- **D1 — contexto obrigatório: recomendo aplicar, com ressalva honesta.**

  O argumento decisivo não é de domínio, é de reversibilidade: **relaxar um
  CHECK depois é uma migration aditiva de uma linha, que não pode quebrar linha
  nenhuma; apertar depois exige migrar dados existentes.** Começar restrito é a
  escolha que preserva as duas saídas.

  A ressalva é real, e não quero que ela apareça só quando incomodar: existem
  pendências legítimas sem paciente. *"Confirmar com a Dra. Ana se ela atende no
  feriado"* e *"revisar os encaixes de amanhã"* são operacionais, nascem do
  fluxo, e não têm paciente, conversa ou agendamento único. Sob a regra
  restrita, ou ficam de fora do sistema — e voltam para o papel, que é o
  problema original —, ou alguém inventa um paciente falso para acomodá-las, o
  que é pior porque polui a base de pacientes.

  **Sinal concreto para reavaliar:** se durante o piloto aparecer pedido
  recorrente de pendência sem contexto, ou se alguém criar paciente fictício, a
  regra caiu — e relaxar custa uma migration.

- **D13 — coerência de contexto: verificar só na criação.**

  Guardar `patient_id` e `conversation_id` juntos não é duplicação (§8). Mas
  passar um par incoerente é bug, e vale barrar. Proponho: **se ambos vierem
  preenchidos na criação e a conversa já tiver paciente, exigir que sejam o
  mesmo** — e **nunca reverificar depois**. Verificação contínua congelaria a
  conversa, impedindo desvincular paciente enquanto houvesse pendência aberta.

- **D16 — sem snapshot de nome em `tasks`; snapshot em `task_events`.**

  A `tasks` guarda estado atual, e nome atual se resolve pelo
  `clinic_member_directory`, que já existe e é seguro (não amplia a policy de
  `profiles`). O histórico é que precisa sobreviver à saída da pessoa — e é
  exatamente onde `conversation_events` já coloca o snapshot. Se o nome mudar
  depois, o histórico mostra o nome de quando o fato aconteceu, que é o correto
  para auditoria.

- **D18 — permissões da v0.1: todos os membros, sem RBAC.**

  Todo membro da clínica vê, cria, assume, transfere, conclui, cancela e
  reabre. Justificativa: numa clínica pequena, pendência sem dono precisa poder
  ser pega por quem estiver livre, e regra de visibilidade fina criaria tarefa
  que ninguém vê.

  Registro a evolução prevista: quando `professional` passar a ter tela própria,
  provavelmente não deve ver pendências administrativas. Isso é um filtro por
  papel sobre uma coluna que **ainda não existe** — e não vou criá-la agora
  (seria `task_type` pela porta dos fundos, contra D12).

### O que eu faria diferente da sua direção

Nada de fundo. As duas únicas divergências são de grau, ambas já acima: a
ressalva sobre **D1** (que recomendo aplicar mesmo assim, por reversibilidade) e
a insistência em **`task_events` na v0.1** (§11) — que é a parte mais cara da
proposta e a que mais merece o seu "não" se o piloto precisar andar antes.

---

## Decisões fechadas nesta proposta

| # | Decisão |
|---|---|
| D1 | Pelo menos um contexto obrigatório, por CHECK — com gatilho explícito de reavaliação |
| D2 | Três estados: `open`, `completed`, `cancelled` |
| D3 | `overdue` derivado, nunca coluna |
| D4 | `due_at` opcional; "Sem prazo" é visão de primeira classe |
| D5 | `assigned_to` nullable, FK composta, `set null (assigned_to)` |
| D6 | `created_by`/`completed_by`/`cancelled_by` de `auth.uid()`, timestamps do servidor |
| D7 | `task_events` append-only desde a v0.1 |
| D8 | Reabrir permitido, dos dois estados terminais, com evento `reopened` |
| D9 | `version` + `expected_version` + RPC atômica + 409 |
| D10 | Sem DELETE, em nenhuma camada |
| D11 | Sem `priority` |
| D12 | Sem `task_type` |
| D13 | Contexto coerente verificado só na criação, nunca depois |
| D14 | Sem recorrência, templates ou automação |
| D15 | Pendência não modifica agendamento nem conversa, e vice-versa |
| D16 | Snapshot de nome só em `task_events`; `tasks` resolve pelo diretório |
| D17 | Sem notificações |
| D18 | Todos os membros da clínica, sem RBAC na v0.1 |
| D19 | `appointments` ganha `unique (clinic_id, id)` — pré-requisito de R1 |
