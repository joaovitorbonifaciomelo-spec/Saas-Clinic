-- =============================================================================
-- 0008 - Fuso horario da clinica
--
-- O banco guarda instantes absolutos (timestamptz). O fuso NAO altera o que e
-- gravado — ele define onde termina a segunda-feira quando a agenda e recortada
-- em dia e semana. Sem essa coluna, o recorte dependeria do navegador, e a mesma
-- clinica veria dias diferentes conforme quem abrisse a tela.
-- =============================================================================

alter table public.clinics
  add column if not exists timezone text not null default 'America/Sao_Paulo';

-- -----------------------------------------------------------------------------
-- Validacao de identificador IANA.
--
-- Feita por trigger e nao por CHECK porque a verificacao consulta
-- pg_timezone_names, que nao e IMMUTABLE e portanto e proibida num CHECK.
-- Consultar o catalogo evita manter uma lista propria de fusos, que ficaria
-- desatualizada a cada mudanca de legislacao de horario.
-- -----------------------------------------------------------------------------
create or replace function public.validate_clinic_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'INVALID_TIMEZONE: "%" nao e um identificador IANA valido.', new.timezone
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists clinics_validate_timezone on public.clinics;
create trigger clinics_validate_timezone
  before insert or update of timezone on public.clinics
  for each row execute function public.validate_clinic_timezone();

comment on column public.clinics.timezone is
  'Fuso IANA usado para recortar dia e semana na agenda. Nao afeta o armazenamento, que e sempre timestamptz.';
