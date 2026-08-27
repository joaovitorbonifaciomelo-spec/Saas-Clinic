-- =============================================================================
-- ROLLBACK do Atendimento Core v0.1 (migrations 0012, 0013 e 0014)
--
-- NAO E EXECUTADO PELO CLI. O `supabase db push` so aplica para frente; este
-- arquivo existe para que a reversao seja uma decisao revisada e nao um script
-- escrito as pressas no dia em que der errado.
--
-- Como executar, se for preciso:
--   psql "$SUPABASE_DB_URL" -f supabase/rollback/20260828_atendimento_down.sql
--
-- =============================================================================
-- !! ISTO APAGA TODOS OS DADOS DE ATENDIMENTO DA INSTANCIA !!
--
-- Conversas, mensagens e o log de auditoria inteiro. O log e imutavel enquanto
-- existe justamente para nao ser perdido por acidente — apaga-lo tem que ser um
-- ato deliberado, e este comentario e o ultimo aviso antes dele.
--
-- Nada FORA do atendimento e tocado: nenhuma tabela da fundacao ou da agenda e
-- alterada, e as migrations 0012-0014 sao puramente aditivas. Por isso este
-- rollback e completo e nao deixa residuo.
-- =============================================================================

begin;

-- 1) Triggers e funcoes ------------------------------------------------------
--    Antes das tabelas por clareza; `drop table ... cascade` levaria os
--    triggers junto, mas nao as funcoes, que sobreviveriam orfas.

drop trigger if exists conversation_events_validate_appointment on public.conversation_events;
drop trigger if exists conversation_events_stamp_actor          on public.conversation_events;
drop trigger if exists conversation_events_prevent_clinic_id_change
  on public.conversation_events;

drop trigger if exists messages_stamp_channel               on public.messages;
drop trigger if exists messages_after_insert                on public.messages;
drop trigger if exists messages_prevent_clinic_id_change    on public.messages;

drop trigger if exists z_conversations_bump_version           on public.conversations;
drop trigger if exists conversations_enforce_status_transition on public.conversations;
drop trigger if exists conversations_prevent_clinic_id_change  on public.conversations;
drop trigger if exists conversations_set_updated_at            on public.conversations;

drop function if exists public.validate_conversation_event_appointment();
drop function if exists public.stamp_conversation_event_actor();
drop function if exists public.current_actor_snapshot(uuid);
drop function if exists public.stamp_message_channel();
drop function if exists public.on_message_inserted();
drop function if exists public.bump_conversation_version();
drop function if exists public.enforce_conversation_status_transition();

-- 2) Tabelas -----------------------------------------------------------------
--    Ordem inversa da criacao: os filhos referenciam conversations por FK
--    composta. `cascade` seria suficiente, mas a ordem explicita documenta a
--    dependencia e falha alto se alguem tiver criado algo novo apontando aqui.

drop table if exists public.conversation_events;
drop table if exists public.messages;
drop table if exists public.conversations;

-- 3) Enums -------------------------------------------------------------------
--    So depois das tabelas: um tipo em uso nao pode ser removido.
--
--    ATENCAO se este rollback for parcial no futuro: `message_delivery_status`
--    e `conversation_channel` sao os candidatos a serem reaproveitados por
--    outro modulo. Hoje sao exclusivos do atendimento.

drop type if exists public.conversation_event_type;
drop type if exists public.message_delivery_status;
drop type if exists public.message_direction;
drop type if exists public.conversation_status;
drop type if exists public.conversation_channel;

commit;

-- Depois de executar, remova tambem as tres migrations de
-- supabase/migrations/ para que um `db push` futuro nao as reaplique:
--   20260828100000_atendimento_schema.sql
--   20260828100100_atendimento_rls.sql
--   20260828100200_atendimento_grants.sql
