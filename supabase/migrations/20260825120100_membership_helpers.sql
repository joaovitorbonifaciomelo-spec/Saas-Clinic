-- =============================================================================
-- 0002 - Helpers de membership usados pelas policies de RLS
--
-- POR QUE SECURITY DEFINER:
-- uma policy em clinic_members que consulta clinic_members reentra na propria
-- policy e o Postgres aborta com "infinite recursion detected in policy".
-- Funcao SECURITY DEFINER roda como o dono (fora do RLS) e quebra o ciclo.
-- E o ponto onde implementacoes ingenuas de multi-tenant falham.
--
-- STABLE permite ao planner avaliar uma vez por query em vez de por linha.
-- set search_path = '' evita sequestro de resolucao de nome por schema no path.
-- =============================================================================

create or replace function public.is_clinic_member(p_clinic_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.clinic_members m
    where m.clinic_id = p_clinic_id
      and m.user_id = (select auth.uid())
  );
$$;

comment on function public.is_clinic_member(uuid) is
  'True se o usuario autenticado participa da clinica informada. Usada pelas policies de RLS.';

create or replace function public.has_clinic_role(
  p_clinic_id uuid,
  p_roles public.clinic_role[]
)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.clinic_members m
    where m.clinic_id = p_clinic_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

comment on function public.has_clinic_role(uuid, public.clinic_role[]) is
  'True se o usuario autenticado tem um dos papeis informados na clinica. Usada pelas policies de RLS.';

-- O default do Postgres concede EXECUTE a PUBLIC. Revogamos explicitamente e
-- concedemos so a quem precisa: nada de anonimo sondando membership.
revoke all on function public.is_clinic_member(uuid) from public, anon;
revoke all on function public.has_clinic_role(uuid, public.clinic_role[]) from public, anon;

grant execute on function public.is_clinic_member(uuid) to authenticated;
grant execute on function public.has_clinic_role(uuid, public.clinic_role[]) to authenticated;
