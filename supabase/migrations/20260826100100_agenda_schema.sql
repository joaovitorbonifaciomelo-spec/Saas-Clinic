-- =============================================================================
-- 0009 - Schema da Agenda Core v0.1
--
-- Tabelas: professionals, services, professional_availability, appointments.
-- RLS vem na 0010; privilegios na 0011.
--
-- INTEGRIDADE MULTI-TENANT POR CONSTRUCAO
--
-- Checagens de integridade referencial IGNORAM RLS: elas rodam como o dono da
-- tabela, fora de qualquer policy. Uma FK simples (patient_id -> patients.id)
-- confirmaria apenas que a linha existe, nao que ela pertence a mesma clinica —
-- e um usuario da Clinica A que conhecesse o UUID de um paciente da Clinica B
-- criaria um agendamento valido apontando para ele.
--
-- Por isso toda FK entre entidades de tenant e COMPOSTA e tenant-first:
--     (clinic_id, patient_id) -> patients (clinic_id, id)
-- O par so fecha se pai e filho estiverem na MESMA clinica. Isso vale para
-- qualquer chamador — API, script, console, inclusive service_role. A API ainda
-- valida antes, mas por UX (404 amigavel), nao como garantia.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Chaves compostas nos pais. Sao o alvo das FKs tenant-first.
-- Redundantes em termos de unicidade (id ja e PK), obrigatorias para o Postgres
-- aceitar o par como referencia.
-- -----------------------------------------------------------------------------
alter table public.patients
  add constraint patients_clinic_id_id_key unique (clinic_id, id);

-- -----------------------------------------------------------------------------
-- professionals
-- -----------------------------------------------------------------------------
create table if not exists public.professionals (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 2 and 120),
  specialty   text check (specialty is null or char_length(btrim(specialty)) between 1 and 120),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint professionals_clinic_id_id_key unique (clinic_id, id)
);

create index if not exists professionals_clinic_active_name_idx
  on public.professionals (clinic_id, active, name);

create trigger professionals_set_updated_at
  before update on public.professionals
  for each row execute function public.set_updated_at();

create trigger professionals_prevent_clinic_id_change
  before update on public.professionals
  for each row execute function public.prevent_clinic_id_change();

-- -----------------------------------------------------------------------------
-- services
-- -----------------------------------------------------------------------------
create table if not exists public.services (
  id                uuid primary key default gen_random_uuid(),
  clinic_id         uuid not null references public.clinics (id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 2 and 120),
  duration_minutes  integer not null check (duration_minutes > 0 and duration_minutes <= 480),
  price_cents       integer check (price_cents is null or price_cents >= 0),
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint services_clinic_id_id_key unique (clinic_id, id)
);

create index if not exists services_clinic_active_name_idx
  on public.services (clinic_id, active, name);

create trigger services_set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

create trigger services_prevent_clinic_id_change
  before update on public.services
  for each row execute function public.prevent_clinic_id_change();

-- -----------------------------------------------------------------------------
-- professional_availability
-- Horario padrao semanal. Orienta a criacao do agendamento; nao bloqueia nada.
-- -----------------------------------------------------------------------------
create table if not exists public.professional_availability (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references public.clinics (id) on delete cascade,
  professional_id  uuid not null,
  weekday          smallint not null check (weekday between 0 and 6),
  start_time       time not null,
  end_time         time not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint professional_availability_range_check check (end_time > start_time),
  constraint professional_availability_professional_fk
    foreign key (clinic_id, professional_id)
    references public.professionals (clinic_id, id) on delete cascade
);

create index if not exists professional_availability_lookup_idx
  on public.professional_availability (clinic_id, professional_id, weekday);

create trigger professional_availability_set_updated_at
  before update on public.professional_availability
  for each row execute function public.set_updated_at();

create trigger professional_availability_prevent_clinic_id_change
  before update on public.professional_availability
  for each row execute function public.prevent_clinic_id_change();

-- -----------------------------------------------------------------------------
-- appointments
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'appointment_status') then
    create type public.appointment_status as enum (
      'scheduled',
      'awaiting_confirmation',
      'confirmed',
      'reschedule_requested',
      'cancelled',
      'completed',
      'no_show'
    );
  end if;
end
$$;

create table if not exists public.appointments (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references public.clinics (id) on delete cascade,
  patient_id       uuid not null,
  professional_id  uuid not null,
  service_id       uuid,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           public.appointment_status not null default 'scheduled',
  notes            text check (notes is null or char_length(notes) <= 2000),
  -- Derivado do JWT no servidor, nunca aceito do frontend.
  -- SET NULL para que remover um usuario nao apague historico de atendimento.
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint appointments_range_check check (ends_at > starts_at),

  -- As tres FKs tenant-first. Ver cabecalho.
  constraint appointments_patient_fk
    foreign key (clinic_id, patient_id)
    references public.patients (clinic_id, id) on delete restrict,
  constraint appointments_professional_fk
    foreign key (clinic_id, professional_id)
    references public.professionals (clinic_id, id) on delete restrict,
  constraint appointments_service_fk
    foreign key (clinic_id, service_id)
    references public.services (clinic_id, id) on delete restrict
);

-- Grade de dia e semana, com e sem filtro por profissional.
create index if not exists appointments_clinic_starts_idx
  on public.appointments (clinic_id, starts_at);
create index if not exists appointments_clinic_professional_starts_idx
  on public.appointments (clinic_id, professional_id, starts_at);
-- Proxima consulta e historico na tela do paciente.
create index if not exists appointments_clinic_patient_starts_idx
  on public.appointments (clinic_id, patient_id, starts_at desc);

create trigger appointments_set_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

create trigger appointments_prevent_clinic_id_change
  before update on public.appointments
  for each row execute function public.prevent_clinic_id_change();

-- -----------------------------------------------------------------------------
-- Transicoes de status
--
-- Fluxo principal:
--   scheduled -> awaiting_confirmation -> confirmed -> completed | no_show
-- Desvios:
--   scheduled | awaiting_confirmation | confirmed -> cancelled
--   awaiting_confirmation | confirmed             -> reschedule_requested
--   reschedule_requested                          -> scheduled | awaiting_confirmation
--
-- cancelled, completed e no_show sao TERMINAIS nesta v0.1.
--
-- No banco e nao so na API: assim a regra vale para qualquer caminho de escrita,
-- e um bug de aplicacao nao consegue produzir historico impossivel.
-- Espelhado em packages/shared/src/appointment.ts.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_appointment_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed public.appointment_status[];
begin
  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'scheduled'             then array['awaiting_confirmation', 'cancelled']
    when 'awaiting_confirmation' then array['confirmed', 'reschedule_requested', 'cancelled']
    when 'confirmed'             then array['completed', 'no_show', 'reschedule_requested', 'cancelled']
    when 'reschedule_requested'  then array['scheduled', 'awaiting_confirmation']
    else array[]::text[]
  end::public.appointment_status[];

  if not (new.status = any (v_allowed)) then
    raise exception 'INVALID_STATUS_TRANSITION: % -> % nao e permitido.', old.status, new.status
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_enforce_status_transition on public.appointments;
create trigger appointments_enforce_status_transition
  before update of status on public.appointments
  for each row execute function public.enforce_appointment_status_transition();

-- -----------------------------------------------------------------------------
-- NAO existe constraint de exclusao (EXCLUDE USING GIST) em appointments.
-- Sobreposicao e DELIBERADAMENTE permitida: a clinica usa encaixe. O conflito e
-- detectado por consulta e confirmado por uma pessoa, nunca bloqueado pelo banco.
-- -----------------------------------------------------------------------------
