# Plano de implementação — Pendências Core v0.1

> **Nada aqui foi implementado.** Este documento descreve a sequência proposta,
> não o resultado. Não contém SQL, migration, endpoint nem componente.
>
> Depende de `pendencias.md`, que fecha o domínio. As decisões **D1–D21** e os
> riscos **R1–R6** citados abaixo estão lá. **Não há decisões abertas** — nada
> aqui espera resposta antes de começar.

---

## 1. Ordem geral

```
1. shared types        ─┐ sem banco, sem risco
2. migrations escritas ─┤ escritas, NÃO aplicadas
3. revisão SQL         ─┤ ponto de parada obrigatório
4. db push Dev         ─┤ requer autorização explícita
5. testes de banco     ─┤ contra o Dev real
6. API leitura         ─┤
7. API escrita/controle─┤
8. frontend            ─┘
9. integrações         ── rodada separada, fora da v0.1
```

Cada etapa termina com as gates do projeto e um relatório. Nenhuma começa sem a
anterior aprovada — a mesma disciplina que o Atendimento Core seguiu.

---

## 2. Etapa 1 — `packages/shared`

Sem banco, sem rede, reversível a custo zero. Fecha o vocabulário antes que ele
se espalhe.

Arquivo novo `packages/shared/src/task.ts`, seguindo a forma de
`conversation.ts`:

- `TASK_STATUSES` + schema zod + tipo + `TASK_STATUS_LABELS`
- `TASK_EVENT_TYPES` (nove) + schema + tipo + labels
- `TASK_STATUS_TRANSITIONS` e `canTransitionTask()` — a máquina de estados de §9
  da proposta, para o frontend não oferecer transição que o banco recusa
- `TITLE_MIN=3`, `TITLE_MAX=200`, `DESCRIPTION_MAX=2000` — **fonte única** para
  zod, CHECK do banco e `maxLength` do input
- `TASK_VIEWS` — as sete visões da §6, como dado e não como `if` espalhado
- `taskDetailsChangedMetadataSchema` — `{fields: TaskEditableField[]}`, que é o
  contrato de **D21** expresso em tipo

Testes unitários em `task.test.ts`, como já se faz.

**Gates:** `lint`, `typecheck`, `test`.

---

## 3. Etapa 2 — migrations escritas (não aplicadas)

Quatro arquivos, na ordem em que precisam existir. Convenção
`AAAAMMDDHHMMSS_assunto.sql`.

### 2a — `appointments_clinic_id_id_key`

Adiciona `unique (clinic_id, id)` a `appointments`, resolvendo **R1**.

Isolada de propósito: é **correção de uma inconsistência pré-existente do schema
da Agenda**, não parte de Pendências. Se Pendências for revertido algum dia,
esta migration continua correta sozinha. Aditiva; nenhuma linha existente pode
violá-la, já que `id` é chave primária.

### 2b — enum e tabela `tasks`

Enum `task_status`. Tabela com os campos de §5 e
`unique (clinic_id, id)`.

Cinco FKs compostas com os `ON DELETE` de §8 — **com lista de colunas no
`set null`**, sob pena de travar a remoção de membros (a armadilha registrada no
plano do Atendimento).

CHECKs: `title` 3–200; `description` ≤ 2000; `version > 0`; e o do invariante 3
**nos dois sentidos** — `completed_at`/`completed_by` presentes se e somente se
`status = 'completed'`, idem `cancelled_*`. **Nenhum CHECK de contexto** (D1).

Triggers: `updated_at`; `clinic_id` imutável; `version` seletiva; carimbo
servidor de `created_by`, `completed_*` e `cancelled_*`.

Os cinco índices de §16.

### 2c — enum e tabela `task_events`

Enum `task_event_type` com os nove tipos. Tabela espelhando
`conversation_events`: FK composta para `tasks` com `cascade`, teto de 2 KB em
`metadata`, `jsonb_typeof(metadata) = 'object'`, e trigger de snapshot do ator
reaproveitando `current_actor_snapshot`.

Índice `(clinic_id, task_id, created_at)`.

### 2d — RLS, grants e RPCs

Policies de `SELECT` por `is_clinic_member` nas duas tabelas. **Ausência
deliberada** de policy de `INSERT`, `UPDATE` e `DELETE` — inclusive em
`task_events`, para que o cliente não consiga forjar histórico (D7).

Grants positivos explícitos; `anon`/`PUBLIC` zerados; `service_role` com os
quatro DML e sem `truncate`/`references`/`trigger`.

RPCs de controle — todas `security definer`, `set search_path = ''`, retorno
uniforme `{outcome, task}`, e todas gravando o evento correspondente:

| RPC | Parâmetros | Evento | Notas |
|---|---|---|---|
| `task_create` | contexto (3 opcionais), título, descrição, prazo, responsável | `created` | `created_by` de `auth.uid()`; aplica a regra de coerência D13 |
| `task_update_details` | id, versão, título, descrição | `details_changed` | metadata só com nomes de campos (D21) |
| `task_assign` | id, versão | `assigned` | trava extra `assigned_to is null` |
| `task_transfer` | id, versão, destinatário | `transferred` | destinatário precisa ser membro da mesma clínica |
| `task_release` | id, versão | `released` | |
| `task_set_due` | id, versão, novo prazo | `due_changed` | aceita nulo (remover prazo) |
| `task_complete` | id, versão | `completed` | |
| `task_cancel` | id, versão | `cancelled` | |
| `task_reopen` | id, versão | `reopened` | limpa `completed_*` **ou** `cancelled_*` conforme a origem |

**Sem** `task_delete`, em nenhuma variante (D10).

**Gates da etapa:** `verify:migrations` (checagens novas escritas junto), `lint`,
`typecheck`, `test`, `check:secrets`. **`db:push` NÃO roda aqui.**

---

## 4. Etapa 3 — revisão do SQL · ponto de parada

Entrego os quatro arquivos para leitura antes de qualquer aplicação. É a etapa
que evitou, no Atendimento, aplicar `grant all` e uma FK sem tenant-first.

O que vale reler com atenção:

- os `on delete set null` **com lista de colunas** — sem ela, remover um membro
  falha por violação de not-null em `clinic_id`;
- o CHECK do invariante 3 nos dois sentidos, que é o que impede tarefa reaberta
  de continuar marcada como concluída;
- a regra de coerência D13 aplicada **só** na criação;
- a lista positiva de grants;
- ausência de policy de UPDATE em `tasks` e de INSERT em `task_events`.

---

## 5. Etapa 4 — `db:push` no Dev

**Só com autorização explícita**, e somente no projeto de desenvolvimento
(`xrhcwtbswzjcvgxyvpel`). Nunca em piloto ou produção.

Sequência: `db:preflight` → conferir project ref e histórico → `db:push` →
**`verify:privileges` imediatamente depois**.

> A verificação de privilégios logo após o push não é zelo excessivo: as
> migrations 0006 e 0014 mostraram que `supabase db push` usa um papel de login
> **sem** default privileges, e as tabelas nascem sem grant nenhum — inclusive
> para `service_role`. O sintoma aparece longe da causa se ninguém olhar na hora.

Sem rollback automático em caso de falha; paro e reporto.

---

## 6. Etapa 5 — testes de banco e isolamento

Cinco arquivos novos em `supabase/tests/`, no estilo dos existentes. Estimativa
de ~95–115 asserções, na mesma ordem de grandeza das suítes do Atendimento.

| Arquivo | ~n | Cobre |
|---|---|---|
| `tasks-schema.test.ts` | ~30 | `clinic_id` imutável; CHECK de conclusão nos dois sentidos; `version` seletiva; transições proibidas recusadas; `set null` ao remover membro **sem bloquear a remoção**; `set null` de paciente ao apagar paciente sem agendamento (R2); tarefa **sem contexto nenhum** aceita (D1); limites de `title`/`description` |
| `tasks-eventos.test.ts` | ~22 | um evento por operação, com o tipo certo; `metadata` de cada tipo; `details_changed` só com nomes de campos (D21); teto de 2 KB; **cliente não consegue inserir evento** nem com JWT válido; snapshot de ator carimbado pelo servidor; histórico sobrevive ao `reopen` |
| `tasks-isolation.test.ts` | ~20 | FK composta recusa contexto de outra clínica **mesmo executada pelo dono da tabela**; `authenticated` sem UPDATE/DELETE; `anon` sem nada; leitura alheia devolve zero linhas; RPC com id de outra clínica devolve `not_found` |
| `tasks-concorrencia.test.ts` | ~14 | **corridas reais**, não requisições serializadas: dois `task_assign` simultâneos (um ok, um conflito); concluir versus mudar prazo; reabrir concorrente; `expected_version` desatualizado sempre `conflict` |
| `tasks-fuso.test.ts` | ~10 | **R3**: clínica em fuso diferente do servidor; pendência às 18h locais aparece em "Hoje" e não em "Atrasadas"; virada de dia; partição completa das quatro visões de prazo |

Ampliar `scripts/verify-migrations.mjs` e `scripts/inspect-privileges.mjs` para
cobrir as tabelas novas — a matriz de privilégios precisa incluí-las, senão o
`verify:privileges` passa sem olhar para elas.

---

## 7. Etapa 6 — API de leitura

Módulo `apps/api/src/tasks/`, seguindo `conversations/`.

| Rota | Devolve |
|---|---|
| `GET /tasks` | lista paginada por keyset, filtro de visão, ordenação padrão |
| `GET /tasks/counts` | os sete contadores em **uma** consulta agregada |
| `GET /tasks/:id` | detalhe |
| `GET /tasks/:id/events` | histórico |

Regras que não são negociáveis, porque já custaram caro antes:

- **Sem `service_role`.** Cliente Supabase por requisição com o JWT do usuário;
  o RLS continua sendo a barreira real.
- **`clinic_id` nunca vem do cliente como verdade** — `ClinicMembershipGuard`, o
  mesmo que teve o bug de dois membros.
- Cross-tenant → **404 idêntico** ao de um UUID inexistente. Sem 403, que
  confirmaria existência.
- **Sem N+1**: paciente, responsável e contexto resolvidos em consulta única com
  embed, como a lista de conversas faz.
- Contadores em uma consulta, não sete.
- Intervalo de "Hoje" calculado com `@ActiveClinicTimezone()` (R3).
- Nomes de responsável pelo `clinic_member_directory`; nomes históricos pelo
  snapshot do evento (D16).

Testes HTTP de segurança junto, não depois.

---

## 8. Etapa 7 — API de escrita e controle

Nove endpoints de controle mapeando 1:1 nas RPCs, com o contrato uniforme:

```
200  outcome = ok
409  outcome = conflict      (versão desatualizada)
404  outcome = not_found     (inexistente ou de outra clínica)
```

`expected_version` **obrigatório** em toda mutação. A API **não** faz
`SELECT version` seguido de `UPDATE` — se fizesse, reintroduziria a corrida que
o padrão existe para eliminar.

A recusa da regra de coerência (D13) precisa de um `outcome` próprio, distinto de
`conflict`: são erros diferentes e a UI reage diferente. Proponho
`patient_mismatch` → **409** com corpo que identifica a causa, seguindo o
precedente de `already_linked` no Atendimento.

---

## 9. Etapa 8 — frontend

Rota `/pendencias`, layout da §14 da proposta.

- Lista compacta, ação rápida **Concluir** na linha
- Sete abas com contador, **incluindo "Sem prazo" mesmo quando zero**
- Pendência sem contexto marcada como **`Geral`**, nunca campo vazio
- Drawer de detalhe com contexto e histórico
- Criação rápida: título, prazo, responsável
- Edição de título/descrição no drawer, enviando `expected_version`
- Server Actions com `revalidatePath`, **despachadas em sequência** — o
  dispatcher do Next é sequencial por cliente, e `Promise.all` de Server Actions
  não paraleliza; só embaralha a ordem
- Conflito 409 exibido como estado de tela ("alguém alterou esta pendência"),
  com recarga — nunca como erro genérico
- **`overdue` vindo do servidor** (R4), nunca comparado com o relógio do
  navegador

Atenção conhecida do projeto: a regra global `button, .btn { … }` no
`globals.css` pinta **todo** `<button>` como primário com texto branco. Já
produziu texto invisível uma vez, e assertivas de `innerText` não pegaram — só o
screenshot pegou. Testes de UI precisam de assertiva de contraste computado.

---

## 10. Etapa 9 — integrações · fora da v0.1

Rodada separada, depois do módulo de pé:

- **Atendimento** — "Criar pendência" na conversa, contexto pré-preenchido
- **Paciente** — aba de pendências na ficha
- **Agendamento** — "Criar pendência" no drawer
- **Hoje** — bloco "Precisa da sua atenção" com contagem de atrasadas e de hoje

O modelo já suporta as quatro; nenhuma exige coluna nova. É por isso que podem
esperar sem custo.

---

## 11. O que não entra, em nenhuma etapa

Recorrência, RRULE, templates, subtarefas, projetos, quadros, categorias
genéricas, prioridade, tipo, DELETE, RBAC por papel, notificações, prontuário e
financeiro.

Automação poderá **criar** pendência no futuro — *"se a consulta continuar
`awaiting_confirmation` 24h antes, criar pendência para a recepção"*. Pendências
v0.1 não depende disso, e o modelo não precisa mudar: uma automação chamaria a
mesma `task_create`.

---

## 12. Ordem dos commits

Um commit por unidade revisável, na ordem das etapas:

| # | Commit | Etapa |
|---|---|---|
| 1 | `feat(shared): tipos e maquina de estados de tasks` | 1 |
| 2 | `fix(agenda): appointments ganha unique (clinic_id, id)` | 2a |
| 3 | `feat(db): schema de tasks` | 2b |
| 4 | `feat(db): task_events append-only` | 2c |
| 5 | `feat(db): RLS, grants e RPCs de controle de tasks` | 2d |
| — | *(revisão + `db:push` autorizado — sem commit de código)* | 3–4 |
| 6 | `test(db): schema, eventos, isolamento, concorrencia e fuso` | 5 |
| 7 | `feat(api): leitura de pendencias` | 6 |
| 8 | `feat(api): controle de pendencias com 409` | 7 |
| 9 | `feat(web): tela de pendencias` | 8 |

O commit 2 vem **antes** do 3 e é independente: corrige o schema da Agenda e
faz sentido sozinho, inclusive se o resto for abandonado.

---

## 13. Riscos do plano

| Risco | Mitigação |
|---|---|
| R1 bloqueia a FK de agendamento | Commit 2 resolve antes, e é aditivo |
| Escopo derivando para lista genérica (R6) | Sem constraint que segure; vigiar os sinais de §3 da proposta durante o piloto |
| Fuso classificando errado (R3) | Suíte dedicada, com clínica fora do fuso do servidor |
| Grants nascendo vazios após o push | `verify:privileges` obrigatório imediatamente após a etapa 4 |
| `metadata` de evento estourando 2 KB | D21 elimina a causa na origem; teste explícito na suíte de eventos |
