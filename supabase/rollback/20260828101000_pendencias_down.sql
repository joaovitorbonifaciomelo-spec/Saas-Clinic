-- =============================================================================
-- ROLLBACK DE DESENVOLVIMENTO — Pendencias Core v0.1
--
-- ############################################################################
-- #  ESTE ARQUIVO APAGA DADOS. `drop table tasks` leva junto TODO o historico #
-- #  de task_events por cascata: quem criou, quem concluiu, quem cancelou,    #
-- #  quem mudou prazo — tudo. Nao ha soft delete, nao ha backup automatico e  #
-- #  nao ha como reconstruir depois.                                          #
-- ############################################################################
--
-- SOMENTE DESENVOLVIMENTO. Nunca em piloto ou producao.
--
-- POR QUE ELE NAO ESTA EM supabase/migrations/
--
-- Porque `supabase db push` aplica TUDO o que encontra la, em ordem. Um script
-- de derrubada dentro do diretorio de migrations seria aplicado no proximo push
-- e apagaria a tabela que o push acabou de criar. Aqui fora, ele so roda se
-- alguem o executar de proposito.
--
-- COMO USAR (manual, e conferindo o alvo antes)
--
--   psql "<connection string do DEV>" -f supabase/rollback/<este arquivo>
--
-- Depois de rodar, a cadeia de migrations volta a poder ser aplicada do zero —
-- as quatro migrations de Pendencias sao reexecutaveis.
--
-- O QUE ELE NAO DESFAZ, DE PROPOSITO
--
-- A constraint `appointments_clinic_id_id_key` PERMANECE. Ela nao pertence a
-- Pendencias: e a correcao de uma inconsistencia pre-existente do schema da
-- Agenda, correta por si so. Derrubar Pendencias nao e motivo para devolver a
-- Agenda a um estado pior do que o que ela tinha.
-- =============================================================================

begin;

-- Ordem: dependentes primeiro. `task_events` referencia `tasks` com cascata,
-- entao o drop de tasks bastaria — mas ser explicito deixa a perda visivel para
-- quem le, em vez de escondida atras de um CASCADE.
drop table if exists public.task_events;
drop table if exists public.tasks;

drop type if exists public.task_event_type;
drop type if exists public.task_status;

-- Funcoes de controle.
drop function if exists public.task_create(uuid, text, text, timestamptz, uuid, uuid, uuid, uuid);
drop function if exists public.task_update_details(uuid, integer, text, text, boolean);
drop function if exists public.task_assign(uuid, integer);
drop function if exists public.task_transfer(uuid, integer, uuid);
drop function if exists public.task_release(uuid, integer);
drop function if exists public.task_set_due(uuid, integer, timestamptz);
drop function if exists public.task_complete(uuid, integer);
drop function if exists public.task_cancel(uuid, integer);
drop function if exists public.task_reopen(uuid, integer);

-- Auxiliares e triggers. `task_row_json` recebe o tipo da tabela, entao precisa
-- cair ANTES dela num cenario diferente deste — aqui a tabela ja caiu, e o
-- Postgres ja removeu a funcao junto com o tipo composto. O IF EXISTS cobre os
-- dois caminhos.
drop function if exists public.task_conflict(uuid);
drop function if exists public.task_member_snapshot(uuid, uuid);
drop function if exists public.stamp_task_event_actor();
drop function if exists public.prevent_task_clinic_change();
drop function if exists public.enforce_task_context_immutable();
drop function if exists public.enforce_task_status_transition();
drop function if exists public.bump_task_version();

commit;
