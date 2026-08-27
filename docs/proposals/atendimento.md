# Proposta técnica — Módulo Atendimento

> **Status: APROVADA** com as 15 decisões registradas em 27/08/2026.
> Este documento é o **domínio decidido**. O “como e em que ordem construir”
> está em [`atendimento-core-v0.1-plano.md`](./atendimento-core-v0.1-plano.md).
>
> **Nada implementado.** Nenhuma migration executada, nenhum endpoint, nenhuma tela.

---

## 1. Fluxo do usuário

```
paciente manda mensagem (hoje: WhatsApp; v0.1: registrada à mão)
        │
        ▼
recepção vê a mensagem numa caixa COMPARTILHADA
        │
        ├── reconhece o número?  não ──► cadastra paciente OU deixa sem vínculo
        │                        sim ──► abre a ficha
        ▼
alguém ASSUME a conversa (para os outros saberem que já tem dono)
        │
        ├── resolve na hora                 ──► resolve
        ├── precisa agendar/reagendar       ──► abre a agenda, marca, responde
        ├── depende de resposta do paciente ──► waiting_patient
        └── depende de alguém de dentro     ──► módulo Pendências (não é estado daqui)
        │
        ▼
paciente responde dias depois ──► conversa VOLTA para a fila
```

Três fatos governam o desenho:

1. **A caixa é compartilhada, não pessoal.** Tudo que for “meu” é explícito.
2. **A conversa não termina de verdade.** `resolved` significa “por ora não há o
   que fazer”, e sempre pode reabrir.
3. **O que a secretária precisa lembrar quase nunca é “responder a mensagem”** —
   é “pedir o exame”, “confirmar com a doutora”. Isso é Pendência (§10).

---

## 2. Entidades — três tabelas

> **DECISÃO 1: sem tabela `Contact` na v0.1.** A identidade externa vive na
> própria conversa. `Patient` continua sendo a entidade central quando
> identificado. Se multi-canal ou múltiplas identidades exigirem depois,
> `Contact` pode ser extraído numa migration futura.

| Entidade | Papel |
|---|---|
| `conversations` | A thread. Identidade externa mínima, estado, responsável, atividade. |
| `messages` | Cada mensagem, entrando ou saindo. |
| `conversation_events` | Log **imutável** de quem fez o quê. |

**`Message` não é audit log** (decisão 9) e **`conversation_events` não guarda
payload de provider** — metadata pequeno e controlado, campos conhecidos.

### O que ficou de fora e por quê

- **`Contact`** — extraível depois. O custo aceito é que o vínculo
  “este número é a Mariana” vive na conversa, e uma segunda thread do mesmo
  número (outro canal, no futuro) precisará vincular de novo.
- **`ConversationAssignment`** — o responsável atual é coluna; o histórico é
  evento. Uma terceira representação da mesma verdade só criaria divergência.
- **`conversation_appointments`** — ver §12.

---

## 3. Campos

### `conversations`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `clinic_id` | uuid NOT NULL | → `clinics(id)` ON DELETE CASCADE |
| `channel` | enum `conversation_channel` | `manual` \| `whatsapp` — **identidade da thread** |
| `provider` | text NULL | Adaptador operacional (`meta_cloud`, `evolution`). NULL em `manual`. |
| `provider_contact_id` | text NULL | Identidade no provedor (ex.: `wa_id`) |
| `contact_phone_e164` | text NULL | `check` de formato E.164 |
| `contact_name_snapshot` | text NULL | Nome que o canal informou. **Não** é o nome do paciente. |
| `patient_id` | uuid NULL | FK composta tenant-first |
| `status` | enum `conversation_status` | `open` \| `waiting_patient` \| `resolved` |
| `assigned_to` | uuid NULL | FK composta para `clinic_members` |
| `last_message_at` | timestamptz NULL | Ordenação da fila |
| `last_inbound_at` | timestamptz NULL | Última do paciente |
| `last_outbound_at` | timestamptz NULL | Último envio da clínica |
| `version` | integer NOT NULL default 1 | Concorrência otimista (§9) |
| `created_at` / `updated_at` | timestamptz | |

> **Recomendação que ajusta a decisão 1.** Vocês listaram `provider` como parte
> da identidade. Proponho separar em **`channel`** (identidade da thread) e
> **`provider`** (coluna operacional).
>
> Motivo concreto: se a clínica trocar de fornecedor — Evolution → Meta Cloud —
> e `provider` fizer parte da identidade, **todo paciente ganha uma thread nova
> e o histórico se parte numa mudança de infraestrutura**. Como o fornecedor
> ainda nem foi escolhido, essa troca é provável, não hipotética.
> `channel = 'whatsapp'` sobrevive à troca; `provider` registra quem entregou.

### `messages`

| Campo | Tipo | Notas |
|---|---|---|
| `conversation_id` | uuid NOT NULL | FK composta com `clinic_id` |
| `direction` | enum | `inbound` \| `outbound` |
| `body` | text NOT NULL | `check` 1..4096 |
| `occurred_at` | timestamptz NOT NULL | Quando aconteceu **no canal** |
| `author_user_id` | uuid NULL | NULL em `inbound` |
| `author_name_snapshot` | text NULL | Autoria preservada (decisão 7) |
| `provider` / `provider_message_id` | text NULL | Idempotência (§8 do plano) |
| `delivery_status` | enum NULL | Só `outbound`; sem uso na v0.1 |

### `conversation_events`

`clinic_id`, `conversation_id`, `event_type`, `actor_user_id` NULL,
`actor_name_snapshot`, `actor_role_snapshot`, `metadata jsonb`, `created_at`.
**Sem UPDATE e sem DELETE**, nem por policy nem por grant.

---

## 4. Estados — três

> **DECISÃO 2.** `open`, `waiting_patient`, `resolved`. Sem `new`, sem
> `waiting_clinic`.

| Estado | Significado operacional |
|---|---|
| `open` | A bola está com a clínica. |
| `waiting_patient` | Fizemos a nossa parte; a bola está com o paciente. |
| `resolved` | Por ora não há o que fazer. |

**“Nova” é visão derivada:** `status = open AND assigned_to IS NULL`. Guardar
como estado criaria a pergunta impossível — uma conversa nova que alguém
assumiu e ainda não respondeu seria `new` ou `open`? Duas pessoas responderiam
diferente e a fila passaria a mentir.

**“Aguardando a clínica” é o próprio `open`.** O caso que sobra — esperar
alguém de dentro — tem dono, prazo e resolução próprios: é Pendência (§10).

```
                    ┌──── mensagem inbound (automático) ────┐
                    ▼                                       │
   (conversa nova) ──► open ◄──────────────────► waiting_patient
                        │  \                            /
                        │   \                          /
                        ▼    ▼                        ▼
                      resolved ◄─────────────────────┘
                        │
                        └──► open  (reabertura: manual OU inbound)
```

**Nenhum estado é terminal** — diferença deliberada em relação a
`appointments`, onde `completed`/`no_show`/`cancelled` são finais. Um
agendamento realizado não volta atrás; uma conversa sempre pode receber outra
mensagem. Fechar e travar perderia mensagem, o pior defeito numa caixa de
entrada.

---

## 5. Três eixos ortogonais

| Eixo | Fonte | Pergunta |
|---|---|---|
| **STATUS** | `status` | De quem é a vez? |
| **RESPONSÁVEL** | `assigned_to` | Quem está cuidando? |
| **ATENÇÃO** | `last_inbound_at` vs `last_outbound_at` | O paciente falou e ninguém respondeu? |

> **DECISÃO 4: sem `unread_count` persistido.** Contador que sobe e desce em dois
> caminhos diferentes sempre diverge. Read-state **não se mistura com status**.

Sinais derivados, sem nenhuma coluna acumuladora:

```sql
precisa_resposta = last_inbound_at is not null
                   and (last_outbound_at is null or last_inbound_at > last_outbound_at)
```

Isto responde melhor que “não lida”: mede **trabalho pendente**, não se alguém
passou o olho. Se “alguém já olhou” virar necessidade, `conversation_reads` /
`last_read_message_id` entram depois como acréscimo puro — sem migration de
forma.

### Visões da fila (consultas, não colunas)

| Visão | Filtro |
|---|---|
| Novas | `status = open AND assigned_to IS NULL` |
| Minhas | `assigned_to = eu AND status <> resolved` |
| Em atendimento | `status = open AND assigned_to IS NOT NULL` |
| Aguardando paciente | `status = waiting_patient` |
| Precisam de resposta | `precisa_resposta` |
| Resolvidas | `status = resolved` |

---

## 6. Identidade da thread

> **DECISÃO 3.** Uma thread contínua por `clinic + channel + identidade
> externa`. Conversa resolvida reabre; não se cria conversa nova por assunto.

O ponto delicado é que **as duas colunas de identidade são nullable**. A regra
tem três casos e cada um recebe seu índice parcial:

| Caso | Identidade | Regra |
|---|---|---|
| Provedor com id próprio | `provider_contact_id` | Uma thread por `(clinic, channel, provider_contact_id)` |
| Só telefone (inclui `manual`) | `contact_phone_e164` | Uma thread por `(clinic, channel, phone)` |
| Nenhuma identidade (`manual` sem telefone) | — | Sem unicidade: cada conversa é própria |

O detalhe que evita o bug: o segundo índice precisa de
`where provider_contact_id is null`, senão o mesmo contato com wa_id **e**
telefone seria bloqueado por duas regras que se contradizem. SQL exato no plano.

---

## 7. Multi-tenant

Mesma filosofia da fundação e da agenda, sem exceção: `clinic_id NOT NULL`,
`unique (clinic_id, id)`, FKs compostas tenant-first, trigger
`prevent_clinic_id_change`, RLS com `is_clinic_member`, grants por
revoke-then-grant **sem `TRUNCATE` e sem `REFERENCES`**, nenhum cliente
escolhendo `clinic_id`.

> **DECISÃO 6: `assigned_to` validado por estrutura.**
> `(clinic_id, assigned_to) → clinic_members(clinic_id, user_id)`.
> Atribuir a alguém de outra clínica passa a ser impossível na estrutura, não
> por lembrança da API. Membership removido devolve a conversa à fila.

> **DECISÃO 11: `patient_id` nullable, com FK tenant-first.**
> `(clinic_id, patient_id) → patients(clinic_id, id)`. Nenhum vínculo
> cross-tenant, **nem via `service_role`** — verificação de FK ignora RLS, e é
> a FK composta que fecha essa porta.

---

## 8. Autoria histórica

> **DECISÃO 7: histórico não desaparece quando um funcionário sai.**

`actor_user_id` nullable **+ `actor_name_snapshot` + `actor_role_snapshot`**.
Membership serve para autorização e atribuição; **não é requisito para manter
histórico**. Removido o usuário: o evento continua legível, o nome permanece
pelo snapshot, e **nada é reatribuído**.

O mesmo vale para `messages.author_name_snapshot`.

---

## 9. Concorrência

> **DECISÃO 10.** `version integer not null default 1`. Assumir, transferir,
> liberar, mudar status, resolver e reabrir comparam a versão esperada e
> atualizam atomicamente. Conflito → **409 com o estado atual**.

Dois atendentes não podem acreditar simultaneamente que assumiram a mesma
conversa. Protocolo detalhado no plano (§12), incluindo o cuidado de que
**chegada de mensagem não invalida operação humana em voo**.

---

## 10. Relação com Pendências

O módulo vem depois. **Nada de `Task` agora.**

| Situação na conversa | Pendência provável |
|---|---|
| Pediu para remarcar e não há horário agora | Retornar com opções, com prazo |
| Precisa enviar pedido de exame | Enviar documento, com responsável |
| Depende de resposta da profissional | Confirmar internamente |
| “Te ligo amanhã de manhã” | Acompanhamento agendado |

**A fronteira:** uma pendência tem dono, prazo e resolução *próprios* e
sobrevive à conversa. O pedido de exame continua pendente mesmo que o paciente
encerre o assunto, e pode ser resolvido por quem nem leu a conversa. Por isso
`status` não ganha um estado por tipo de espera.

---

## 11. Relação com Patient

`patient_id` nullable. Suportado na v0.1: contato desconhecido, vincular
existente, criar e vincular, **trocar vínculo só com ação explícita**,
desvincular com evento de auditoria.

**Vínculo nunca é automático por telefone parecido.** Casar por telefone
sozinho pode expor a ficha de outra pessoa — o erro que este produto não pode
cometer.

---

## 12. Relação com Appointment — decisão explicada

> **DECISÃO 12: a v0.1 NÃO persiste vínculo conversa↔agendamento. Sem tabela,
> sem coluna.**

O raciocínio, em três passos:

1. **Coluna `appointment_id` está descartada de saída.** Uma conversa produz
   vários agendamentos ao longo do tempo (marcou, remarcou, marcou o retorno).
   Uma coluna guardaria só o último e apagaria em silêncio justamente o
   histórico que a recepção quer consultar.
2. **`conversation_appointments` seria o modelo certo — para um requisito que a
   v0.1 não tem.** O escopo aprovado (decisão 13) pede que a UX consiga
   *abrir/criar* agendamento a partir do paciente da conversa. Isso precisa de
   `patient_id` e do drawer que a agenda já tem. Não precisa de persistência.
3. **Criar a tabela agora custaria a manutenção de uma junção que ninguém lê**,
   e adiar é barato: acrescentar uma tabela de ligação depois é aditivo e não
   quebra nada.

**O custo aceito, dito com clareza:** sem persistir, não haverá dado
retroativo. Quando alguém perguntar “quantos agendamentos nasceram do
atendimento?”, a resposta começará do dia em que a tabela existir.

**Alternativa de uma linha, se quiserem histórico desde o dia um:** ao criar um
agendamento a partir da conversa, gravar um `conversation_events` com
`event_type = 'appointment_created'` e `metadata = {"appointment_id": "…"}`.
Nenhuma tabela nova, histórico preservado, e a tabela de ligação vira uma
consolidação futura do que já estará no log. **Fica como decisão de vocês** —
recomendo aceitar, o custo é um INSERT.

---

## 13. Desacoplar o provedor

> **DECISÃO 5: `channel = 'manual'` aprovado.** O Atendimento Core funciona de
> ponta a ponta com `manual` **antes** de existir qualquer integração.

```
   ┌──────────────────────────────────────────┐
   │  DOMÍNIO — o que a v0.1 constrói         │
   │  conversations · messages · events       │
   │  estados · atribuição · vínculo · versão │
   └───────▲──────────────────────┬───────────┘
           │ porta de entrada     │ porta de saída
           │ IncomingMessage      │ OutboundMessage
   ┌───────┴──────────┐   ┌───────▼──────────┐
   │ · manual  (v0.1) │   │ · manual  (v0.1) │
   │ · meta cloud     │   │ · meta cloud     │
   │ · evolution      │   │ · evolution      │
   └──────────────────┘   └──────────────────┘
```

`manual` prova domínio, atribuição, vínculo com paciente, estados,
concorrência, histórico e UX sem webhook, sem QR code e sem número de teste.

**E `manual` não finge ser WhatsApp.** A UI diz “registro manual”, o composer
não promete entrega, e `channel` é visível na conversa. Registrar uma ligação
telefônica é a função — não uma simulação de mensageria.

---

## 14. Eventos

> **DECISÃO 9.** Entidade própria e imutável. Avaliei a redundância pedida.

**`resolved` e `reopened` saem; `status_changed` com `{from, to}` cobre os
dois.** São a mesma operação — transição de status pelo mesmo endpoint.

**`assigned` / `transferred` / `released` ficam separados**, e a distinção não é
arbitrária: são **três operações diferentes, com três endpoints diferentes e
três frases diferentes na tela**. A regra que apliquei é *um tipo por operação
que a pessoa executa*, não um tipo por valor resultante.

| Tipo | Metadata controlado |
|---|---|
| `conversation_created` | `{channel}` |
| `assigned` | `{to_user_id}` |
| `transferred` | `{from_user_id, to_user_id}` |
| `released` | `{from_user_id}` |
| `patient_linked` | `{patient_id}` |
| `patient_unlinked` | `{patient_id}` |
| `status_changed` | `{from, to, reason?}` — reabertura automática usa `reason: "inbound_message"` com `actor_user_id` NULL |
| `appointment_created` | `{appointment_id}` — **só se aceitarem a alternativa da §12** |

`metadata` é jsonb **pequeno e de chaves conhecidas**. Payload bruto de
provider não entra: é volumoso, muda de formato entre fornecedores e pode
carregar dado pessoal que não escolhemos guardar.

---

## 15. O que NÃO entra na v0.1

Meta WhatsApp Cloud API · Evolution · webhook · envio real · anexos · áudio ·
templates/HSM · QR code · automações · tarefas/Pendências · SLA · chatbot/IA ·
busca full-text · notificações push · grupos · leitura por atendente ·
episódios por assunto · ações em lote · edição/exclusão de mensagem.

---

## 16. UX

> **DECISÃO 14.** Sidebar ganha **“Atendimento”**. Desktop em três áreas.
> Visual não é implementado neste passo — wireframe e plano de telas no
> documento de plano (§17).

```
┌────────┬───────────────────────┬─────────────────────────────┬──────────────────────┐
│  side  │  FILA  ~320px         │  THREAD  flex               │  CONTEXTO  ~300px    │
│  bar   ├───────────────────────┼─────────────────────────────┼──────────────────────┤
│        │ [buscar nome/telefone]│ ┌─────────────────────────┐ │ ┌──────────────────┐ │
│ Hoje   │                       │ │ MB  Mariana Barros      │ │ │ MB Mariana Lima  │ │
│ Agenda │ Novas 3 · Minhas 2 ·  │ │     (11) 98765-4321     │ │ │ (11) 98765-4321  │ │
│ Atend. │ Aguardando · Todas    │ │     ● Ana · manual      │ │ │ Unimed           │ │
│ Pacien.│                       │ │ [Transferir][Resolver]  │ │ └──────────────────┘ │
│        │ ┌───────────────────┐ │ └─────────────────────────┘ │                      │
│ GESTÃO │ │● MB Mariana  14:32│ │                             │ PRÓXIMA CONSULTA     │
│ Profis.│ │  Pode ser quinta? │ │        ┌──────────────────┐ │ 31/08 12:30          │
│ Serviç.│ │  ○ sem responsável│ │        │ Oi, preciso re…  │ │ Dra. Carla · Proced. │
│        │ ├───────────────────┤ │        │             14:28│ │                      │
│        │ │  JS João      13:0│ │        └──────────────────┘ │ HISTÓRICO            │
│        │ │  Obrigado!        │ │  ·· Ana assumiu · 14:29 ··  │ 26/08 Retorno        │
│        │ │  ◐ Ana · aguard.  │ │ ┌────────────────────┐      │ 12/08 Consulta       │
│        │ └───────────────────┘ │ │ Claro! Tenho quin… │      │                      │
│        │                       │ │ Ana · 14:30        │      │ [+ Novo agendamento] │
│        │                       │ └────────────────────┘      │ [  Vincular paciente]│
│        │                       │ [registro manual ▾ ] [Env.] │                      │
└────────┴───────────────────────┴─────────────────────────────┴──────────────────────┘
```

Eventos de sistema aparecem na thread como **linhas discretas** (`·· Ana
assumiu · 14:29 ··`), não como mensagens — são de outra natureza e não podem
competir visualmente com o que o paciente disse.

Mobile: pilha `FILA → THREAD → CONTEXTO (sheet)`, ações no rodapé onde o polegar
alcança.

---

## Decisões fechadas

| # | Decisão |
|---|---|
| 1 | Sem `Contact`; identidade externa mínima na conversa |
| 2 | Três status: `open`, `waiting_patient`, `resolved` |
| 3 | Uma thread por clínica + canal + identidade externa |
| 4 | Sem `unread_count`; sinais derivados de timestamps |
| 5 | `channel = 'manual'` funcionando de ponta a ponta |
| 6 | `assigned_to` validado por FK composta contra `clinic_members` |
| 7 | Autoria preservada por snapshot; membership não é requisito de histórico |
| 8 | Idempotência por `(clinic_id, provider, provider_message_id)` desde a primeira migration |
| 9 | `conversation_events` próprio e imutável; `Message` não é audit log |
| 10 | Concorrência otimista com `version` e 409 |
| 11 | `patient_id` nullable com FK tenant-first |
| 12 | Sem persistência de vínculo com agendamento na v0.1 |
| 13 | Escopo funcional da v0.1 conforme lista aprovada |
| 14 | Sidebar + três áreas no desktop |
| 15 | Proposta atualizada; plano de implementação em documento separado |

## Pontos que ainda voltam para vocês

1. **`channel` separado de `provider`** (§3) — recomendo separar, para que troca
   de fornecedor não parta o histórico de todo paciente.
2. **`appointment_created` como evento** (§12) — recomendo aceitar; custa um
   INSERT e preserva histórico desde o dia um.
