-- =============================================================================
-- appointments ganha unique (clinic_id, id)
--
-- CORRECAO ESTRUTURAL PRE-EXISTENTE DO SCHEMA DA AGENDA.
--
-- Seis tabelas do projeto ja carregam a chave composta — patients,
-- professionals, services, conversations, messages, conversation_events.
-- `appointments` ficou de fora, e a ausencia so aparece quando alguem tenta
-- referencia-la tenant-first. Pendencias foi o primeiro modulo a tentar.
--
-- POR QUE ISSO IMPORTA
--
-- Uma FK simples `appointment_id -> appointments(id)` seria aceita pelo
-- Postgres e estaria ERRADA: a verificacao de FK ignora RLS, entao ela deixaria
-- uma clinica apontar para o agendamento de outra. A chave composta e o que
-- torna a mistura impossivel no catalogo, sem depender de disciplina de
-- aplicacao.
--
-- POR QUE E SEGURA
--
-- Duplicidade de (clinic_id, id) e IMPOSSIVEL por construcao: `id` e chave
-- primaria, entao dois registros nao podem repetir o id — muito menos o par.
-- Nao ha dado existente capaz de violar a constraint, em nenhum ambiente.
--
-- Migration ADITIVA e independente. A 0009 (agenda_schema) nao foi editada: ela
-- ja foi aplicada, e reescrever historico aplicado esconderia o que aconteceu.
-- Esta continua correta sozinha, mesmo que Pendencias seja abandonado.
-- =============================================================================

alter table public.appointments
  drop constraint if exists appointments_clinic_id_id_key;

alter table public.appointments
  add constraint appointments_clinic_id_id_key unique (clinic_id, id);

comment on constraint appointments_clinic_id_id_key on public.appointments is
  'Alvo de FKs tenant-first. Sem ela, referenciar um agendamento so seria '
  'possivel por FK simples, que ignora RLS e aceitaria outra clinica.';
