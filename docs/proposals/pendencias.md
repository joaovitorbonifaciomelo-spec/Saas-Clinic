# Proposta técnica — Módulo Pendências

> **Status: proposta aprovada com ajustes. Nada implementado.** Nenhuma
> migration, SQL, endpoint, componente ou teste foi escrito.
>
> **Não há decisões abertas.** Todas as questões que a primeira versão deixou em
> aberto (A1–A5) foram decididas e estão incorporadas ao texto.
>
> Escrita depois de ler o schema real — `patients`, `appointments`,
> `conversations`, `clinic_members`, `profiles`, os helpers de RLS, os grants e
> o padrão de RPC do Atendimento.

---

## 1. O problema real

A recepção da clínica carrega, o dia inteiro, um conjunto de coisas que
*precisam ser feitas depois*: retornar para alguém, tentar um encaixe quando
abrir horário, cobrar um documento, acompanhar uma solicitação, lembrar de algo
ligado a um agendamento, resolver uma questão operacional.

Hoje essas coisas moram em memória, em conversa de WhatsApp deixada aberta de
propósito, em papel, ou em "depois eu faço".

Todos esses lugares têm o mesmo defeito: **a informação depende de a pessoa
certa lembrar, no momento certo.** Quando ela falta, sai de férias ou
simplesmente tem um dia cheio, a tarefa desaparece sem deixar rastro — e o
paciente é quem descobre.

Pendências existe para tirar isso da memória.

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

**Uma pendência pode não ter contexto nenhum.** *"Confirmar com a Dra. Ana se
ela atende no feriado"*, *"revisar os encaixes de amanhã"*, *"resolver a questão
do bebedouro da recepção"* — são ações internas legítimas, nascem do fluxo real
e não pertencem a um paciente, uma conversa ou um agendamento específico. Ver §3.

---

## 3. O que não pertence — e o que passou a proteger essa fronteira

Não é Trello, kanban, gerenciador de projetos, calendário paralelo, CRM,
automação, fila de mensagens, prontuário nem financeiro.

Continuam fora, explicitamente: projetos, quadros, prioridade, subtarefas,
recorrência, categorias genéricas, colaboração de projeto, notificações
(push/e-mail/WhatsApp/badge em tempo real), automações e a integração com a
página Hoje.

### A mudança de natureza da fronteira · leia isto

A primeira versão desta proposta protegia o escopo com um **CHECK no banco**:
toda pendência precisava de ao menos um contexto. Essa exigência **caiu**, por
uma razão que aceito integralmente — forçar contexto empurraria a pendência
geral da clínica para duas saídas piores: voltar para o papel (o problema
original) ou inventar um paciente fictício (que polui a base de pacientes, e é
pior ainda).

Mas a consequência precisa ficar dita, porque é uma troca real:

> **A fronteira deixou de ser estrutural e passou a ser de vocabulário.** Antes,
> o banco recusava a tarefa genérica. Agora, o que impede a deriva é o módulo
> **não ter as palavras** para gerenciamento de projeto: sem prioridade, sem
> tipo, sem subtarefa, sem quadro, sem projeto, sem recorrência, e com uma tela
> que é lista operacional e não board.

Isso funciona — a ausência de afordância é uma barreira legítima e, em muitos
casos, mais honesta que uma constraint que gera contorno. Mas ela é **mais
frouxa**, e depende de o produto continuar dizendo não.

**Sinais concretos de deriva, para vigiar durante o piloto:**

- pendências sem contexto viram a **maioria** das pendências abertas;
- aparecem pedidos de agrupamento, etiqueta, cor, ordem manual ou "quadro";
- aparecem títulos que descrevem projeto e não ação (*"Reforma da sala 2"*);
- a mesma pendência genérica é recriada toda semana — sintoma de que o pedido
  real é recorrência, que está fora de escopo por decisão.

Se dois desses aparecerem juntos, a conversa a ter não é "adicionar campo": é
decidir se existe um segundo produto ali.

Três exclusões merecem o porquê, porque são as que a pressão de uso vai tentar
furar:

- **Não modifica as entidades que referencia.** Concluir uma pendência não
  confirma um agendamento nem encerra uma conversa. O módulo observa; não
  comanda.
- **Não é canal de comunicação.** Pendência não manda mensagem. Se a ação é
  "mandar mensagem", quem manda é o Atendimento, e a pendência é o lembrete de
  fazê-lo.
- **Não é prontuário.** Ver §14, sobre `description`.

---

## 4. Modelo proposto

Duas tabelas.

| Tabela | Papel |
|---|---|
| `tasks` | estado atual da pendência |
| `task_events` | histórico append-only do que aconteceu com ela |

Nomenclatura: `tasks` em inglês, como todo o schema (`conversations`,
`appointments`, `patients`). "Pendências" é o nome do produto, na UI.

---

## 5. Modelo final — campos

### `tasks`

| Campo | Tipo | Nota |
|---|---|---|
| `id` | uuid pk | |
| `clinic_id` | uuid **not null** | FK → `clinics(id)` `on delete cascade` |
| `title` | text **not null** | `char_length(btrim(title)) between 3 and 200` |
| `description` | text null | `<= 2000`, mesmo teto de `appointments.notes` |
| `status` | `task_status` **not null** default `'open'` | ver §6 |
| `assigned_to` | uuid null | FK composta → `clinic_members(clinic_id, user_id)` |
| `due_at` | timestamptz null | opcional; ver §6 |
| `patient_id` | uuid null | **opcional**; FK composta → `patients(clinic_id, id)` |
| `conversation_id` | uuid null | **opcional**; FK composta → `conversations(clinic_id, id)` |
| `appointment_id` | uuid null | **opcional**; FK composta → `appointments(clinic_id, id)` — exige a migration de R1 |
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

**Não existem** nesta lista, e é deliberado: `priority`, `task_type`,
`deleted_at`, `overdue`, `patient_name_snapshot` (ver R2), e **nenhum CHECK
exigindo contexto**.

### `task_events`

Mesma forma que `conversation_events`, que já provou funcionar:

| Campo | Nota |
|---|---|
| `id`, `clinic_id`, `task_id` | FK composta → `tasks(clinic_id, id)` `on delete cascade` |
| `event_type` | enum `task_event_type`, ver §11 |
| `actor_user_id` | → `auth.users(id)` `on delete set null` |
| `actor_name_snapshot` | text, `1..120` |
| `actor_role_snapshot` | `clinic_role` |
| `metadata` | jsonb `not null default '{}'`, objeto, `<= 2048 bytes` |
| `created_at` | timestamptz |

O snapshot de nome fica **aqui**, não na `tasks` — ver §11.

---

## 6. Estados e prazo

```
open ──► completed
  │  ◄──────┘  (reabrir)
  │
  └──► cancelled
       ◄──┘     (reabrir)
```

`open`, `completed`, `cancelled`. Nada mais. Sem `new`, `in_progress`,
`waiting`, `overdue`, `today` ou `upcoming`.

`due_at` é **opcional**. Obrigar produziria prazo falso, e prazo falso destrói o
sinal de "Atrasadas", que é o mais valioso da tela.

### Visões derivadas — nunca colunas

| Recorte | Derivação |
|---|---|
| Atrasadas | `status = 'open' and due_at < início do dia local` |
| Hoje | `status = 'open'` e `due_at` dentro do dia local da clínica |
| Próximas | `status = 'open' and due_at >` fim do dia local |
| Sem prazo | `status = 'open' and due_at is null` |
| Minhas | `status = 'open' and assigned_to = auth.uid()` |
| Sem responsável | `status = 'open' and assigned_to is null` |
| Concluídas | `status = 'completed'` |

**Todos os cortes de dia usam `clinics.timezone`**, nunca o relógio do servidor
nem o do navegador. Ver R3 e R4.

### 6.1 Duas perguntas diferentes sobre atraso · leia antes de implementar

O produto tem **dois** conceitos de "atrasada", ambos legítimos, e confundi-los
foi a contradição que a primeira versão deste documento carregava.

| | `isPastDueNow` | recorte `due=overdue` |
|---|---|---|
| Pergunta | *o horário desta pendência já passou neste instante?* | *esta pendência pertence a um dia anterior ao dia local de hoje?* |
| Fórmula | `due_at < agora` | `due_at < início de hoje no fuso da clínica` |
| Onde vive | campo de cada item do read model | filtro da aba |
| Para que serve | destacar visualmente uma pendência de hoje cujo horário venceu | montar a aba **Atrasadas** |

O exemplo que separa os dois: uma pendência para **hoje às 09h**, consultada às
**10h**, tem

```
due=today       -> aparece na aba Hoje
isPastDueNow    -> true
due=overdue     -> NAO aparece
```

**"Hoje" é o dia local inteiro**, mesmo que o horário já tenha passado. É por
isso que as quatro abas continuam sendo uma partição: se *Atrasadas* usasse
`due_at < agora`, essa mesma pendência estaria em duas abas ao mesmo tempo, e a
soma dos contadores passaria a ser maior que o total de pendências abertas.

Nenhuma tela deve calcular qualquer um dos dois no navegador: o corte depende do
fuso da clínica, que o navegador não conhece, e do relógio do servidor, que é o
único confiável. Ver R3 e R4.

> **Propriedade que vale registrar: nenhuma pendência aberta pode ficar
> invisível.** *Atrasadas*, *Hoje*, *Próximas* e *Sem prazo* formam uma partição
> completa de `status = 'open'` — toda tarefa aberta tem `due_at` nulo (Sem
> prazo) ou não nulo, e nesse caso cai em exatamente uma das outras três. Isso
> não é coincidência de UI: é a garantia de que o módulo cumpre o que promete,
> que é nada sumir.

`in_progress` merece um parágrafo, porque é o que mais se pede: ele parece
informação e quase nunca é. Quem "começou" uma ligação que não completou não
mudou o mundo; a pendência continua pendente.

---

## 7. Invariantes finais

1. **`clinic_id` é imutável.** Trigger, como em `patients` (migration 0005).
2. **`created_by` vem de `auth.uid()`**, nunca do cliente. Idem `completed_by` e
   `cancelled_by`. Timestamps do servidor.
3. **`completed_at`/`completed_by` existem se e somente se `status =
   'completed'`.** Mesma regra para `cancelled_*`. CHECK nos dois sentidos — é o
   que impede uma tarefa reaberta de continuar carregando a marca de concluída.
4. **`due_at` não tem restrição de futuro.** Ao contrário de
   `messages.occurred_at`, que rejeita futuro porque descreve um fato passado,
   `due_at` descreve intenção — criar hoje uma pendência com prazo de ontem é
   legítimo.
5. **Coerência de contexto verificada só na criação**, nunca depois. Ver §8.
6. **Toda FK de contexto é tenant-first e composta.** Cross-tenant é
   estruturalmente impossível, e não por confiança na aplicação.
7. **`tasks` não aceita `UPDATE` nem `DELETE` de `authenticated`** — nem por
   policy, nem por grant. Toda mudança passa por RPC controlada.
8. **`task_events` é append-only e o cliente nunca insere nele** — sem policy de
   INSERT, sem grant de INSERT. Só as RPCs `security definer` escrevem.
9. **Transições válidas**: `open→completed`, `open→cancelled`,
   `completed→open`, `cancelled→open`. As diretas entre terminais são recusadas.

**Deixou de existir** o invariante da versão anterior que exigia ao menos um
contexto.

---

## 8. Relações

### Por que as FKs são compostas

`(clinic_id, patient_id) → patients(clinic_id, id)`, e não
`patient_id → patients(id)`. A verificação de FK **ignora RLS**: uma FK simples
aceitaria alegremente o `patient_id` de outra clínica. A chave composta torna a
mistura impossível no nível do catálogo. Padrão já aplicado em `appointments` e
`conversations`. **FK simples por `appointment_id` está recusada.**

### `ON DELETE` de cada uma — lido do schema, não presumido

| FK | Regra | Por quê |
|---|---|---|
| `clinic_id → clinics(id)` | `cascade` | raiz do tenant |
| `(clinic_id, assigned_to) → clinic_members(clinic_id, user_id)` | `set null (assigned_to)` | tirar alguém da clínica não pode travar a remoção nem apagar a tarefa; ela volta para a fila geral |
| `(clinic_id, patient_id) → patients(clinic_id, id)` | `set null (patient_id)` | `patients` **tem** DELETE real (policy `patients_delete_admin`); ver R2 |
| `(clinic_id, conversation_id) → conversations(clinic_id, id)` | `set null (conversation_id)` | preserva "a tarefa sobrevive ao contexto" |
| `(clinic_id, appointment_id) → appointments(clinic_id, id)` | `set null (appointment_id)` | idem |
| `created_by`, `completed_by`, `cancelled_by → auth.users(id)` | `set null` | mesmo tratamento de `appointments.created_by` |
| `(clinic_id, task_id) → tasks(clinic_id, id)` *(em `task_events`)* | `cascade` | evento não existe sem a tarefa |

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

### `patient_id` + `conversation_id`: por que os dois, e o que significam

Não é duplicação. São afirmações diferentes:

- `conversation.patient_id` — *"com quem estamos falando"*, o vínculo **atual**
  da conversa.
- `task.patient_id` — *"sobre quem é esta ação"*, fixado no momento da criação.

O vínculo da conversa **muda depois**: o Atendimento suporta vincular,
desvincular e trocar paciente com ação explícita (migration 0020). Se a tarefa
resolvesse o paciente por join, desvincular a conversa amanhã apagaria
retroativamente o sujeito de uma tarefa criada hoje — isso é reescrever
história.

**Se a conversa for desvinculada no futuro, `task.patient_id` não muda.**

### Regra de coerência — só na criação

Quando a tarefa é criada com `conversation_id` **e** `patient_id`:

| Estado da conversa naquele momento | Resultado |
|---|---|
| vinculada a um paciente **diferente** | **recusar** |
| vinculada ao **mesmo** paciente | aceitar |
| **sem** paciente vinculado | aceitar |

Verificada **uma vez**, na criação ou na vinculação inicial. **Nunca
reverificada.** Constraint contínua congelaria a conversa: seria impossível
desvincular um paciente enquanto houvesse pendência aberta apontando para ele,
o que transformaria uma decisão do Atendimento em refém do módulo de Pendências.

### `appointment_id`: por que aqui é diferente do Atendimento

A decisão 12 do Atendimento recusou `conversations.appointment_id` — e a recusa
**não se aplica aqui**, por cardinalidade, não por gosto:

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

Proibidas: `completed→cancelled` e `cancelled→completed` diretas — quem errou
reabre primeiro, e o caminho fica legível no histórico.

**Reabrir é permitido, por qualquer membro da clínica.** Sem isso, um clique
errado é permanente, e a resposta da equipe a um sistema que não perdoa é parar
de usá-lo.

Ao reabrir:

- vindo de `completed`, limpa `completed_at` e `completed_by`;
- vindo de `cancelled`, limpa `cancelled_at` e `cancelled_by`;
- grava o evento `reopened`;
- **a informação de que já esteve concluída/cancelada não se perde** — ela está
  em `task_events`, junto com quem fez e quando.

Concluir ou cancelar **não altera nada fora da tarefa**: nem status do
agendamento, nem status da conversa. E o contrário também: cancelar um
agendamento **não** cancela a pendência ligada a ele — ela continua aberta, e a
UI mostra que o agendamento relacionado foi cancelado.

---

## 10. Concorrência

**Mesmo padrão já aprovado em `conversations`** — `version` +
`expected_version` + RPC atômica + 409 na API. Nada de last-write-wins
silencioso.

O cenário é real: Maria conclui enquanto João muda o prazo. Sem proteção, o
último UPDATE vence em silêncio e uma das duas ações desaparece sem que ninguém
saiba.

- A API **nunca** faz `SELECT version` seguido de `UPDATE`. `expected_version` é
  obrigatório e vem do cliente, que o recebeu na leitura.
- Toda mudança passa por RPC `security definer` com `set search_path = ''`.
- Retorno uniforme `{outcome, task}` com `outcome ∈ {ok, conflict, not_found}`,
  traduzido pela API em `200 | 409 | 404`.
- `tasks` **não recebe policy nem grant de UPDATE** para `authenticated`. Duas
  camadas dizendo a mesma coisa — e, como registrado no Atendimento, a ausência
  de policy é o que impede que um grant acidental reabra o caminho.
- `task_assign` usa a trava extra `and assigned_to is null`, como
  `conversation_assign`: duas pessoas nunca recebem sucesso no mesmo assign,
  ainda que a versão coincida por outro caminho.

`version` é incrementada por trigger, e **seletivamente** — mudança de
`updated_at` sozinha não conta como alteração concorrente.

---

## 11. Auditoria — `task_events` na v0.1

Append-only. Nove tipos:

```
created · details_changed · assigned · transferred · released
due_changed · completed · reopened · cancelled
```

**O cliente nunca insere.** Seguindo exatamente o que `conversation_events` já
faz — nenhuma policy de INSERT, e grant apenas de `SELECT` para `authenticated`
—, os eventos são escritos só pelas RPCs `security definer`. Um evento forjado
pelo navegador é impossível, não improvável.

`actor_user_id`, `actor_name_snapshot` e `actor_role_snapshot` são carimbados
por trigger a partir de `current_actor_snapshot()`, a função que o Atendimento
já usa. **Actor e timestamp nunca vêm do cliente.**

### Histórico e read model são responsabilidades diferentes

| Pergunta | Fonte |
|---|---|
| "Quem é a responsável **agora**?" | `assigned_to` + `clinic_member_directory` |
| "Quem concluiu, e quando?" | `completed_by`/`completed_at` na linha |
| "Quem mudou o prazo, e para quê?" | `task_events` |
| "Como se chamava quem fez isso, **na época**?" | `actor_name_snapshot` no evento |

Os campos atuais continuam existindo **junto** com os eventos, e isso não é
redundância: a lista precisa de "quem concluiu" sem join, e o histórico precisa
de "o que aconteceu" sem varrer. Mesma divisão de `conversations`, que tem
`last_message_at` **e** eventos.

Se o nome de alguém mudar depois, a linha atual mostra o nome novo (via
diretório) e o histórico mostra o nome de quando o fato aconteceu. É o correto
para auditoria.

### `metadata` recomendada por evento

| Evento | `metadata` |
|---|---|
| `created` | `{contexto: {patient_id?, conversation_id?, appointment_id?}, due_at?, assigned_to?}` — só as chaves presentes |
| `assigned` | `{to_user_id}` |
| `transferred` | `{from_user_id, to_user_id}` |
| `released` | `{from_user_id}` |
| `due_changed` | `{from, to}` — dois timestamptz ou nulo |
| `completed`, `cancelled` | `{}` — autor e instante já estão nas colunas do evento |
| `reopened` | `{from_status}` — `completed` ou `cancelled` |
| `details_changed` | **ver abaixo** |

### `details_changed`: recomendação explícita

> **Recomendo registrar apenas os NOMES dos campos alterados, sem valores.**
>
> ```
> {"fields": ["title"]}
> {"fields": ["title", "description"]}
> ```

Três razões, a primeira decisiva:

1. **`old`/`new` completos não cabem.** `description` vai até 2000 caracteres, e
   o teto de `metadata` é 2048 bytes — o mesmo já adotado em
   `conversation_events`. Uma única edição de descrição longa **estouraria a
   constraint** e a operação falharia, com uma mensagem que ninguém relacionaria
   à causa. Guardar valores exigiria abrir mão do teto, e o teto existe para
   impedir que a tabela de eventos vire depósito.
2. **Duplicar `description` nos eventos multiplica a exposição do texto.**
   `description` carrega instrução operacional que pode mencionar pessoas.
   Copiá-la para uma segunda tabela, a cada edição, cria N cópias do mesmo
   conteúdo sensível sem que ninguém tenha pedido histórico textual.
3. **A pergunta operacional é "alguém mexeu nisto?"**, não "qual era a vírgula
   anterior". Quem precisa do texto atual, lê a tarefa; quem precisa saber que
   mudou, e quem mudou, tem o evento.

**Assimetria rejeitada:** guardar `old`/`new` só para `title` (que cabe em 400
bytes) e não para `description` produziria um histórico que às vezes tem valores
e às vezes não — pior de entender do que um que nunca tem.

Se algum dia o histórico textual virar requisito real, ele é aditivo: uma tabela
própria, com retenção própria, sem sequestrar o campo `metadata`. **Não é
sistema de versionamento de texto, e não deve virar um por acidente.**

---

## 12. RLS e multi-tenant

| Item | `tasks` | `task_events` |
|---|---|---|
| `SELECT` | `is_clinic_member(clinic_id)` | `is_clinic_member(clinic_id)` |
| `INSERT` | **sem policy** — só RPC | **sem policy** — só RPC |
| `UPDATE` | **sem policy** | **sem policy** (append-only) |
| `DELETE` | **sem policy** | **sem policy** |

Mais: `clinic_id` imutável por trigger; `created_by` de `auth.uid()`;
`anon`/`PUBLIC` com zero em tabela e em função; API normal **sem
`service_role`**, sem bypass de RLS; cross-tenant devolve **404 idêntico** ao de
um UUID inexistente (non-disclosure — um 403 confirmaria existência).

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
service_role:   select, insert, update, delete
                — sem truncate, references ou trigger.
```

> **Armadilha conhecida, e que já mordeu duas vezes** (migrations 0006 e 0014):
> `supabase db push` roda com um papel de login **sem** default privileges, e as
> tabelas nascem **sem grant nenhum**, inclusive para `service_role`. A migration
> de grants é obrigatória e o `verify:privileges` precisa rodar logo após o push.

Revogações por privilégio nomeado, nunca `revoke all` — `revoke all` derrubaria
também os que devem ficar, e o resultado passaria a depender da ordem das
instruções.

---

## 14. UX conceitual — `/pendencias`

Não é kanban. É uma lista operacional que responde "o que falta fazer" em um
olhar.

```
┌──────────────────────────────────────────────────────────────┐
│  Pendências                              [ + Nova pendência ] │
├──────────────────────────────────────────────────────────────┤
│  Atrasadas 3 │ Hoje 5 │ Próximas 8 │ Sem prazo 2              │
│  Minhas 4    │ Sem responsável 6 │ Concluídas                 │
├──────────────────────────────────────────────────────────────┤
│  ● Ligar sobre encaixe de quinta                              │
│    Maria Silva · ontem 14:00 · Ana · Atendimento    [Concluir]│
│  ○ Solicitar exame antes da consulta                          │
│    João Souza · hoje 17:00 · sem responsável · Agenda         │
│  ○ Confirmar com a Dra. Ana se atende no feriado              │
│    Geral · sem prazo · Ana                          [Concluir]│
└──────────────────────────────────────────────────────────────┘
```

**Pendência sem contexto aparece marcada como `Geral`** — não como espaço vazio.
Um campo em branco lê-se como dado faltando; um rótulo lê-se como decisão.

**Nenhuma visão é redundante:**

- **Atrasadas** e **Hoje** são disjuntas por construção — a fronteira das duas
  é a **meia-noite local**, não o instante atual. Separadas porque exigem
  reações diferentes: atrasada é dívida, hoje é plano. Ver §6.1.
- **Sem prazo** não aparece em nenhuma das outras. Se virasse aba escondida, o
  módulo recriaria o problema que veio resolver. **O contador aparece mesmo
  quando zero.**
- **Minhas** e **Sem responsável** cortam por dono, não por tempo; cruzam-se com
  as outras e não substituem nenhuma.

Contadores em todas as abas: sem número, a aba não informa nada antes do clique.

**Ação rápida `Concluir` direto na linha** — é a operação mais frequente e não
deve custar navegação. Ao clicar no item, drawer com descrição, contexto
completo e histórico.

Criação rápida com atrito mínimo: **título, prazo, responsável**. Quando criada
de outro módulo (Atendimento, Paciente, Agendamento), o contexto vem
pré-selecionado e não é digitado. O modelo já suporta; a integração não é v0.1.

### Sobre `description`

`description` guarda **instrução operacional** — "Ligar para o paciente sobre o
horário" —, não conteúdo clínico. O banco não tem como entender semântica de
texto, então isso é regra de produto: fica registrada aqui, no placeholder do
campo e na documentação. O teto de 2000 caracteres sinaliza a intenção, mas não
a garante. Reforça a decisão de §11: não copiar esse texto para os eventos.

---

## 15. Consultas principais

Todas escopadas por `clinic_id`, sempre. Ordenação padrão: `due_at asc nulls
last, created_at asc` — o mais urgente primeiro, sem prazo por último.

```
fila por prazo       clinic_id + status='open'  → ordena por due_at
atrasadas            clinic_id + status='open' + due_at < :agora
hoje                 clinic_id + status='open' + due_at entre :inicio e :fim
próximas             clinic_id + status='open' + due_at > :fim
sem prazo            clinic_id + status='open' + due_at is null
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
> é calculado nesse fuso e enviado como dois `timestamptz` — a consulta continua
> um range simples e continua usando índice.

Paginação por keyset, como em `conversations`, com a ramificação
`due_at is null` tratada explicitamente — é a que costuma ser esquecida.

---

## 16. Índices

Cinco em `tasks`, um em `task_events`. Cada um existe por uma consulta acima, e
nenhum por precaução.

| Índice | Serve |
|---|---|
| `(clinic_id, status, due_at asc nulls last, id)` | fila principal, atrasadas, hoje, próximas, sem prazo — todas são recortes do mesmo range |
| `(clinic_id, assigned_to, status, due_at)` **where** `assigned_to is not null` | "Minhas" |
| `(clinic_id, patient_id)` **where** `patient_id is not null` | futura aba na ficha do paciente |
| `(clinic_id, conversation_id)` **where** `conversation_id is not null` | pendências de uma conversa |
| `(clinic_id, appointment_id)` **where** `appointment_id is not null` | pendências de um agendamento |
| `(clinic_id, task_id, created_at)` em `task_events` | histórico |

Os três de contexto são **parciais** de propósito — e com contexto agora
totalmente opcional isso pesa mais, não menos: a maioria das linhas terá nulo em
pelo menos dois deles, e indexar nulos custaria espaço sem servir consulta
nenhuma.

**Não proponho** índice para "sem responsável" (`assigned_to is null`): o
primeiro índice já filtra por `clinic_id + status`, e o volume dentro de uma
clínica não justifica um parcial dedicado. Se a fila geral doer, ele é aditivo.

---

## 17. Riscos

### R1 — `appointments` não tem `unique (clinic_id, id)` · **resolvido no plano**

Seis tabelas têm a chave composta — `patients`, `professionals`, `services`,
`conversations`, `messages`, `conversation_events`. **`appointments` não tem.**

Consequência: a FK `(clinic_id, appointment_id) → appointments(clinic_id, id)`
**não pode ser criada hoje** — o PostgreSQL exige índice único sobre exatamente
as colunas referenciadas.

FK simples e validação por trigger foram **recusadas**: a primeira aceitaria
agendamento de outra clínica (FK ignora RLS), e a segunda trocaria garantia de
catálogo por disciplina de aplicação.

**Decidido:** adicionar `unique (clinic_id, id)` a `appointments`, como primeira
migration. É **correção de uma inconsistência pré-existente do schema da
Agenda** — não dívida criada por Pendências, que apenas foi o primeiro módulo a
esbarrar nela. A migration é aditiva, isolada, e continua correta sozinha mesmo
que Pendências seja revertido.

### R2 — `patients` tem DELETE real · custo aceito

A policy `patients_delete_admin` permite hard delete por admin, e o grant existe.
Um paciente **com** agendamento está protegido (`appointments.patient_fk` é
`on delete restrict`); um paciente **sem** agendamento pode ser apagado.

Com `set null (patient_id)` a tarefa sobrevive e perde o sujeito: sobra "Ligar
para confirmar" sem dizer para quem.

- `restrict` faria uma pendência cancelada de meses atrás bloquear a exclusão de
  um cadastro — desproporcional.
- `patient_name_snapshot` resolveria a legibilidade, ao custo de um campo que na
  prática quase nunca seria lido.

**Decidido: `set null (patient_id)`, com a perda aceita.** O caso é raro
(paciente sem nenhum agendamento, apagado por admin, com pendência viva) e o
evento `created` guarda o `patient_id` original em `metadata`, permitindo
reconstruir o vínculo se um dia importar. Custo aceito, não descuido.

### R3 — "Hoje" e "Atrasada" dependem do fuso da clínica

`now()` no banco é UTC. Uma pendência para "hoje às 18h" em São Paulo vira 21h
UTC; um corte de dia em UTC classificaria errado tudo que cai entre 21h e
meia-noite local — justamente o fim do expediente, onde as pendências se
acumulam.

A infraestrutura existe. O risco é esquecer de usá-la e descobrir pelo relato de
uma recepcionista de que "a tarefa sumiu de Hoje". Vira suíte dedicada.

### R4 — `overdue` calculado no cliente diverge do servidor

Se o frontend classificar "atrasada" com o relógio do navegador, um computador
com hora errada mostra uma fila diferente da real. A classificação vem do
servidor.

### R5 — `appointments` não tem `version`

`conversations` tem controle otimista; `appointments` não. Pendências será o
segundo uso do padrão. Não é problema deste módulo — é uma assimetria do produto
que vale registrar, porque um dia alguém vai perguntar por que a agenda não
protege contra edição simultânea.

### R6 — a fronteira do escopo ficou mais frouxa · **novo**

Consequência direta de tornar o contexto opcional. Detalhado em §3, com os
sinais de deriva a vigiar. Registrado como risco porque a proteção deixou de ser
verificável pelo banco e passou a depender de disciplina de produto — e risco
que depende de disciplina precisa estar escrito, ou some.

---

## 18. Decisões fechadas

Nenhuma questão em aberto.

| # | Decisão |
|---|---|
| D1 | **Contexto totalmente opcional.** Sem CHECK. Tarefa sem contexto é "pendência geral da clínica" e é legítima |
| D2 | Três estados: `open`, `completed`, `cancelled` |
| D3 | `overdue` derivado, nunca coluna |
| D4 | `due_at` opcional; "Sem prazo" é visão de primeira classe, com contador visível mesmo em zero |
| D5 | `assigned_to` nullable, FK composta, `set null (assigned_to)` |
| D6 | `created_by`/`completed_by`/`cancelled_by` de `auth.uid()`; timestamps do servidor; actor do evento de fonte confiável |
| D7 | `task_events` append-only na v0.1, nove tipos, cliente nunca insere |
| D8 | Reabrir permitido dos dois terminais, por qualquer membro, com evento `reopened` |
| D9 | `version` + `expected_version` + RPC atômica + 409 |
| D10 | Sem DELETE, em nenhuma camada. Criada errada → cancelar |
| D11 | Sem `priority` |
| D12 | Sem `task_type` |
| D13 | Coerência de contexto só na criação; conversa com paciente **diferente** recusa; sem paciente ou mesmo paciente aceita; nunca reverificada |
| D14 | Sem recorrência, subtarefa, projeto, quadro, categoria ou template |
| D15 | Pendência não modifica agendamento nem conversa, e vice-versa |
| D16 | Snapshot de nome só em `task_events`; estado atual pelo `clinic_member_directory` |
| D17 | Sem notificações |
| D18 | Todos os membros da clínica, sem RBAC na v0.1 |
| D19 | `appointments` ganha `unique (clinic_id, id)` — correção de inconsistência pré-existente |
| D20 | `title` e `description` editáveis por RPC com `expected_version`, gerando `details_changed` |
| D21 | `details_changed.metadata` guarda **só os nomes dos campos alterados**, nunca old/new |
| D22 | Tarefa terminal fica **congelada**: só `reopen` é aceito. As outras cinco devolvem `invalid_state` |
| D23 | `invalid_state` é outcome próprio, com `reason` — distinto de `conflict` e de `not_found` |
| D24 | Precedência fixa: existência/membership → `expected_version` → regra de domínio |
| D25 | Contexto é **imutável**: não há RPC para trocá-lo. Errado se resolve cancelando e criando outra |
| D26 | No-ops devolvem `ok` sem gastar versão nem gerar evento |
| D27 | `created.metadata` guarda o responsável inicial quando houver; `dueAt` não |
| D28 | `valor → nulo` no contexto só é aceito de ação referencial, distinguida por `pg_trigger_depth()` |
| D29 | Índices finais: **2** em `tasks`, 1 em `task_events`. Os de contexto e o de Concluídas ficam para quando houver consulta |
