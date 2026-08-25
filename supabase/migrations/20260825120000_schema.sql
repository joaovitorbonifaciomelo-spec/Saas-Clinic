-- =============================================================================
-- 0001 - Schema base da fundacao v0.1
-- Tabelas: profiles, clinics, clinic_members, patients
-- Sem RLS ainda: as policies vem na migration 0003.
-- =============================================================================

create extension if not exists pgcrypto;

-- Papeis dentro de uma clinica. Espelhado em packages/shared/src/roles.ts.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'clinic_role') then
    create type public.clinic_role as enum ('admin', 'attendant', 'professional');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Gatilho generico de updated_at
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles: dado de aplicacao do usuario, 1:1 com auth.users
-- ON DELETE CASCADE: o perfil nao faz sentido sem a conta.
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null check (char_length(btrim(full_name)) between 2 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- clinics: o tenant.
-- created_by e NULLABLE com ON DELETE SET NULL de proposito: a clinica pertence
-- a organizacao, nao a quem clicou em "criar". Apagar o usuario nao pode apagar
-- (nem bloquear a exclusao de) a clinica e os pacientes dela.
-- -----------------------------------------------------------------------------
create table if not exists public.clinics (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 120),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger clinics_set_updated_at
  before update on public.clinics
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- clinic_members: a ponte usuario <-> clinica. O unique composto ja permite que
-- um usuario participe de varias clinicas sem mudanca de schema no futuro.
-- -----------------------------------------------------------------------------
create table if not exists public.clinic_members (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.clinic_role not null default 'attendant',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint clinic_members_unique_membership unique (clinic_id, user_id)
);

create index if not exists clinic_members_user_id_idx on public.clinic_members (user_id);

create trigger clinic_members_set_updated_at
  before update on public.clinic_members
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- patients: primeiro dado de negocio, existe nesta fase para PROVAR o isolamento.
-- -----------------------------------------------------------------------------
create table if not exists public.patients (
  id                  uuid primary key default gen_random_uuid(),
  clinic_id           uuid not null references public.clinics (id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 2 and 120),
  phone               text not null check (phone ~ '^[0-9]{10,13}$'),
  birth_date          date,
  insurance_provider  text check (insurance_provider is null or char_length(btrim(insurance_provider)) between 1 and 120),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Toda consulta de paciente e sempre escopada por clinica: o indice reflete isso.
create index if not exists patients_clinic_id_name_idx on public.patients (clinic_id, name);

create trigger patients_set_updated_at
  before update on public.patients
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Criacao automatica do profile no cadastro.
--
-- SECURITY DEFINER porque roda no contexto do signup, antes de existir sessao.
--
-- SOBRE O NOME: `handle_new_user` e `on_auth_user_created` sao os nomes usados
-- em praticamente todo tutorial oficial do Supabase, entao sao os mais provaveis
-- de ja existirem num projeto qualquer. Um `create or replace function` sobre um
-- nome desses substituiria a funcao alheia SEM ERRO e sem aviso, e a quebra so
-- apareceria no proximo cadastro.
--
-- O prefixo `clinic_saas_` nao torna a colisao impossivel — qualquer nome pode
-- colidir. Torna-a extremamente improvavel, porque deixa de depender do nome
-- mais disputado do ecossistema. Esta migration INSTALA UM TRIGGER EM auth.users:
-- verifique se `clinic_saas_on_auth_user_created` ja existe antes de aplicar.
-- -----------------------------------------------------------------------------
create or replace function public.clinic_saas_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists clinic_saas_on_auth_user_created on auth.users;
create trigger clinic_saas_on_auth_user_created
  after insert on auth.users
  for each row execute function public.clinic_saas_handle_new_user();
