# Plano de implementação — Pendências Core v0.1

> **Nada aqui foi implementado.** Este documento descreve a sequência proposta,
> não o resultado. Não contém SQL, migration, endpoint nem componente — por
> decisão da rodada que o encomendou.
>
> Depende de `pendencias.md`, que fecha o domínio. As decisões **D1–D19** e os
> riscos **R1–R5** citados abaixo estão lá.

---

## 0. Pré-requisitos antes da etapa 1

Duas coisas precisam de resposta sua antes de qualquer código:

| Bloqueio | Por quê |
|---|---|
| **A1** — contexto obrigatório? | Muda um CHECK e a UX de criação a partir de `/pendencias` |
| **A2** — `task_events` na v0.1? | Muda o número de tabelas, RPCs, suítes e etapas. É a decisão de maior impacto no cronograma |

`A3`, `A4` e `A5` têm padrão recomendado e não bloqueiam o início.

**Se `A2` for "adiar"**, o plano encolhe: some a etapa 2c, some metade da 4, e
**a decisão D8 (reabrir) precisa ser revista junto** — sem eventos, reabrir
apaga a informação de que a tarefa esteve concluída (§11 da proposta). Não são
escolhas independentes.

---

## 1. Ordem geral

```
1. shared types        ─┐ sem banco, sem risco
2. migrations escritas ─┤ escritas, NÃO aplicadas
3. revisão SQL         ─┤ ponto de parada obrigatório
4. db push Dev         ─┤ requer sua autorização explícita
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

Sem banco, sem rede, reversível a custo zero. Serve para fechar o vocabulário
antes que ele se espalhe.

Arquivo novo `packages/shared/src/task.ts`, seguindo a forma de
`conversation.ts`:

- `TASK_STATUSES` + schema zod + tipo + `TASK_STATUS_LABELS`
- `TASK_EVENT_TYPES` + schema + tipo *(só se A2 = v0.1)*
- `TASK_STATUS_TRANSITIONS` e `canTransitionTask()` — a mesma máquina de estados
  de §9 da proposta, para que o frontend não invente transição que o banco
  recusa
- Limites de `title` (3–200) e `description` (≤2000) como constantes exportadas,
  **fonte única** para zod, CHECK do banco e `maxLength` do input
- `TASK_VIEWS` — as sete visões da §14, como dado e não como `if` espalhado

Testes unitários no mesmo arquivo-irmão (`task.test.ts`), como já se faz.

**Gates:** `lint`, `typecheck`, `test`.

---

## 3. Etapa 2 — migrations escritas (não aplicadas)

Quatro arquivos, na ordem em que precisam existir. Nomes seguindo a convenção
`AAAAMMDDHHMMSS_assunto.sql`.

### 2a — pré-requisito em `appointments`

Adiciona `unique (clinic_id, id)` a `appointments`, resolvendo **R1**.

Aditivo e isolado de propósito: é correção de uma inconsistência que já existe
no schema, não parte de Pendências. Se algum dia Pendências for revertido, esta
migration continua correta sozinha.

### 2b — schema de `tasks`

Enum `task_status`; tabela `tasks` com os campos de §5; `unique (clinic_id, id)`;
as cinco FKs compostas com os `ON DELETE` de §8 — **com lista de colunas no
`set null`**, sob pena de travar a remoção de membros (a armadilha registrada no
plano do Atendimento); os CHECKs dos invariantes 4 e 2; os cinco índices de §16.

Triggers: `updated_at`, `clinic_id` imutável, `version` seletiva, carimbo de
`created_by`/`completed_*`/`cancelled_*` no servidor.

### 2c — `task_events` *(só se A2 = v0.1)*

Enum `task_event_type`; tabela espelhando `conversation_events`, incluindo o teto
de 2 KB em `metadata` e o trigger de snapshot do ator reaproveitando
`current_actor_snapshot`.

### 2d — RLS e grants

Policies de `SELECT` por `is_clinic_member`. **Ausência deliberada** de policy de
`INSERT`, `UPDATE` e `DELETE`. Grants positivos explícitos, `anon`/`PUBLIC`
zerados, `service_role` com os quatro DML e sem `truncate`/`references`/
`trigger`.

RPCs de controle, todas `security definer` + `set search_path = ''`, todas com
retorno uniforme `{outcome, task}`:

| RPC | Parâmetros | Notas |
|---|---|---|
| `task_create` | contexto, título, descrição, prazo, responsável | `created_by` de `auth.uid()`; valida D1 e D13 |
| `task_assign` | id, versão esperada | trava extra `assigned_to is null` |
| `task_transfer` | id, versão esperada, destinatário | destinatário precisa ser membro da mesma clínica |
| `task_release` | id, versão esperada | |
| `task_set_due` | id, versão esperada, novo prazo | aceita nulo (remover prazo) |
| `task_complete` | id, versão esperada | |
| `task_cancel` | id, versão esperada | |
| `task_reopen` | id, versão esperada | limpa `completed_*`/`cancelled_*` |
| `task_update_text` | id, versão esperada, título, descrição | sem evento, por A4 |

**Sem** `task_delete`, em nenhuma variante (D10).

**Gates da etapa:** `verify:migrations` (as checagens novas escritas junto),
`lint`, `typecheck`, `test`, `check:secrets`. **`db:push` NÃO roda aqui.**

---

## 4. Etapa 3 — revisão do SQL · ponto de parada

Entrego os quatro arquivos para leitura antes de qualquer aplicação. É a etapa
que evitou, no Atendimento, aplicar `grant all` e uma FK sem tenant-first.

O que vale reler com atenção:

- os `on delete set null` **com lista de colunas** — sem ela, remover um membro
  falha por violação de not-null em `clinic_id`
- o CHECK do invariante 4 nos dois sentidos, que é o que impede tarefa reaberta
  de continuar marcada como concluída
- a lista positiva de grants
- ausência de policy de UPDATE

---

## 5. Etapa 4 — `db:push` no Dev

**Só com sua autorização explícita**, e somente no projeto de desenvolvimento
(`xrhcwtbswzjcvgxyvpel`). Nunca em piloto ou produção.

Sequência: `db:preflight` → conferir o project ref e o histórico → `db:push` →
**`verify:privileges` imediatamente depois**.

> A verificação de privilégios logo após o push não é zelo excessivo: as
> migrations 0006 e 0014 mostraram que `supabase db push` usa um papel de login
> **sem** default privileges, e as tabelas nascem sem grant nenhum — inclusive
> para `service_role`. O sintoma aparece longe da causa se ninguém olhar na hora.

Sem rollback automático em caso de falha; paro e reporto.

---

## 6. Etapa 5 — testes de banco e isolamento

Arquivos novos em `supabase/tests/`, no estilo dos existentes:

- **`tasks-schema.test.ts`** — invariantes: `clinic_id` imutável; contexto
  obrigatório (D1); coerência só na criação (D13); CHECK de conclusão nos dois
  sentidos; `version` incrementando seletivamente; transições proibidas
  recusadas; `set null` disparando ao remover membro **sem bloquear a remoção**;
  `set null` de paciente ao apagar paciente sem agendamento (**R2**).
- **`tasks-isolation.test.ts`** — cross-tenant estruturalmente impossível: FK
  composta recusa contexto de outra clínica **mesmo executada pelo dono da
  tabela**; `authenticated` sem UPDATE/DELETE; `anon` sem nada; leitura alheia
  devolve zero linhas.
- **`tasks-concorrencia.test.ts`** — **corridas reais**, não duas requisições
  deliberadamente serializadas: dois `task_assign` simultâneos, um ok e um
  conflito; concluir versus mudar prazo ao mesmo tempo; reabrir concorrente.
- **`tasks-fuso.test.ts`** — **R3**: clínica em fuso diferente do servidor, com
  pendência às 18h locais, precisa aparecer em "Hoje" e não em "Atrasadas".

Ampliar `scripts/verify-migrations.mjs` e `scripts/inspect-privileges.mjs` para
cobrir as tabelas novas — a matriz de privilégios precisa incluí-las, senão o
`verify:privileges` passa sem olhar para elas.

---

## 7. Etapa 6 — API de leitura

Módulo `apps/api/src/tasks/`, seguindo `conversations/`.

| Rota | Devolve |
|---|---|
| `GET /tasks` | lista paginada por keyset, filtros de visão, contadores |
| `GET /tasks/:id` | detalhe |
| `GET /tasks/:id/events` | histórico *(se A2 = v0.1)* |

Regras que não são negociáveis, porque já custaram caro antes:

- **Sem `service_role`.** Cliente Supabase por requisição com o JWT do usuário;
  o RLS continua sendo a barreira real.
- **`clinic_id` nunca vem do cliente como verdade** — `ClinicMembershipGuard`, o
  mesmo que teve o bug de dois membros.
- Cross-tenant → **404 idêntico** ao de um UUID inexistente. Sem 403, que
  confirmaria existência.
- **Sem N+1**: paciente, responsável e contexto resolvidos em consulta única com
  embed, como a lista de conversas faz.
- Os contadores das sete abas em **uma** consulta agregada, não sete.
- O intervalo de "Hoje" calculado com `@ActiveClinicTimezone()` (**R3**).

Testes HTTP de segurança junto, não depois.

---

## 8. Etapa 7 — API de escrita e controle

Endpoints de controle mapeando 1:1 nas RPCs, com o contrato uniforme:

```
200  outcome = ok
409  outcome = conflict      (versão desatualizada)
404  outcome = not_found     (inexistente ou de outra clínica)
```

`expected_version` **obrigatório** em toda mutação. A API **não** faz
`SELECT version` seguido de `UPDATE` — se fizesse, reintroduziria a corrida que
o padrão existe para eliminar.

---

## 9. Etapa 8 — frontend

Rota `/pendencias`, layout da §14 da proposta.

- Lista compacta, ação rápida **Concluir** na linha
- Sete abas com contador, **incluindo "Sem prazo" mesmo quando zero**
- Drawer de detalhe com contexto e histórico
- Criação rápida: título, prazo, responsável
- Server Actions com `revalidatePath`, **despachadas em sequência** — o
  dispatcher do Next é sequencial por cliente, e `Promise.all` de Server Actions
  não paraleliza; só embaralha a ordem
- Conflito 409 exibido como estado de tela ("alguém alterou esta pendência"),
  com recarga — nunca como erro genérico
- **`overdue` vindo do servidor** (**R4**), nunca comparado com o relógio do
  navegador

Atenção conhecida do projeto: a regra global `button, .btn { … }` no
`globals.css` pinta **todo** `<button>` como primário com texto branco. Já
produziu texto invisível uma vez, e assertivas de `innerText` não pegaram —
só o screenshot pegou. Testes de UI precisam de assertiva de contraste
computado.

---

## 10. Etapa 9 — integrações · fora da v0.1

Rodada separada, depois do módulo estar de pé:

- **Atendimento** — botão "Criar pendência" na conversa, contexto pré-preenchido
- **Paciente** — aba de pendências na ficha
- **Agendamento** — "Criar pendência" no drawer
- **Hoje** — bloco "Precisa da sua atenção" com contagem de atrasadas e de hoje

O modelo já suporta as quatro; nenhuma exige coluna nova. É por isso que elas
podem esperar sem custo.

---

## 11. O que não entra, em nenhuma etapa

Recorrência, RRULE, templates, notificações (push, e-mail, WhatsApp, badge em
tempo real), automações, prioridade, tipo/categoria, DELETE, RBAC por papel,
prontuário e financeiro.

Automação poderá **criar** pendência no futuro — *"se a consulta continuar
`awaiting_confirmation` 24h antes, criar pendência para a recepção"*. Pendências
v0.1 não depende disso, e o modelo não precisa mudar para permitir: uma
automação chamaria a mesma `task_create`.

---

## 12. Riscos do plano

| Risco | Mitigação |
|---|---|
| **R1** bloqueia a FK de agendamento | Etapa 2a resolve antes, e é aditiva |
| `A2` respondido tarde | Etapas 1 e 2a/2b não dependem dele; começar por elas |
| Escopo vazando para "lista genérica" | D1 aplicado no banco, com gatilho de reavaliação registrado |
| Fuso classificando errado | Suíte dedicada na etapa 5, com clínica fora do fuso do servidor |
| Grants nascendo vazios após o push | `verify:privileges` obrigatório imediatamente após a etapa 4 |
