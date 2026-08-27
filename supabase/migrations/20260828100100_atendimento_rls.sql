-- =============================================================================
-- 0013 - RLS do Atendimento
--
-- Mesma forma da fundacao e da agenda: AUSENCIA DE POLICY E NEGACAO TOTAL, e os
-- helpers SECURITY DEFINER quebram a recursao que uma policy consultando
-- clinic_members causaria.
--
-- Tres ausencias sao deliberadas, nao esquecimento:
--
--   conversations       sem UPDATE  - mudanca de estado so pelas funcoes de
--                                     controle, onde a versao esperada e
--                                     obrigatoria (ver 0012 e 0014).
--                       sem DELETE  - conversa nao se apaga: resolve.
--   messages            sem UPDATE  - mensagem e fato consumado.
--                       sem DELETE
--   conversation_events sem INSERT  - o log e escrito so por caminhos
--                       sem UPDATE    controlados; membro nao fabrica evento.
--                       sem DELETE
--
-- Quando o provedor chegar, `messages.delivery_status` vai precisar de uma
-- policy de UPDATE restrita a essa coluna. Migration futura, decisao futura.
-- =============================================================================

alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;
alter table public.conversation_events enable row level security;

-- -----------------------------------------------------------------------------
-- conversations
-- -----------------------------------------------------------------------------
drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member
  on public.conversations
  for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

drop policy if exists conversations_insert_member on public.conversations;
create policy conversations_insert_member
  on public.conversations
  for insert
  to authenticated
  with check (public.is_clinic_member(clinic_id));

-- SEM policy de UPDATE, e a ausencia e a defesa.
--
-- `authenticated` tambem nao tem o privilegio (0014), entao ha duas camadas
-- dizendo a mesma coisa. Deixar a policy aqui seria pior do que inutil: se
-- alguem reconciliasse os grants e devolvesse UPDATE — e a plataforma do
-- Supabase reconcilia default privileges —, a policy permissiva reabriria o
-- caminho que a 0014 fechou. Sem policy, um grant acidental nao vira brecha.
--
-- Mudanca de estado passa pelas funcoes de controle da 0012, onde a versao
-- esperada e obrigatoria.
drop policy if exists conversations_update_member on public.conversations;

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
drop policy if exists messages_select_member on public.messages;
create policy messages_select_member
  on public.messages
  for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

drop policy if exists messages_insert_member on public.messages;
create policy messages_insert_member
  on public.messages
  for insert
  to authenticated
  with check (public.is_clinic_member(clinic_id));

-- -----------------------------------------------------------------------------
-- conversation_events
-- -----------------------------------------------------------------------------
drop policy if exists conversation_events_select_member on public.conversation_events;
create policy conversation_events_select_member
  on public.conversation_events
  for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

-- SEM policy de INSERT, pelo mesmo motivo.
--
-- O log e escrito apenas por triggers e funcoes SECURITY DEFINER da 0012, que
-- rodam como dono da tabela e por isso nao passam por policy. Um membro nao
-- fabrica evento: nem o tipo nem o metadata sao escolhidos pelo cliente.
drop policy if exists conversation_events_insert_member on public.conversation_events;
