-- =============================================================================
-- 0013 - RLS do Atendimento
--
-- Mesma forma da fundacao e da agenda: AUSENCIA DE POLICY E NEGACAO TOTAL, e os
-- helpers SECURITY DEFINER quebram a recursao que uma policy consultando
-- clinic_members causaria.
--
-- Tres ausencias sao deliberadas, nao esquecimento:
--
--   conversations       sem DELETE  - conversa nao se apaga: resolve.
--   messages            sem UPDATE  - mensagem e fato consumado.
--                       sem DELETE
--   conversation_events sem UPDATE  - o log e IMUTAVEL, e isso passa a ser
--                       sem DELETE    propriedade do banco em vez de promessa
--                                     da aplicacao.
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

drop policy if exists conversations_update_member on public.conversations;
create policy conversations_update_member
  on public.conversations
  for update
  to authenticated
  using (public.is_clinic_member(clinic_id))
  with check (public.is_clinic_member(clinic_id));

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

drop policy if exists conversation_events_insert_member on public.conversation_events;
create policy conversation_events_insert_member
  on public.conversation_events
  for insert
  to authenticated
  with check (public.is_clinic_member(clinic_id));
