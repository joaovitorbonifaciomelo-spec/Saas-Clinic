-- =============================================================================
-- 0004 - RPC de onboarding: unica porta de entrada para criar clinica
--
-- clinics nao tem policy de INSERT e clinic_members nao tem policy de escrita.
-- Esta funcao e SECURITY DEFINER, entao roda fora do RLS e consegue gravar as
-- duas linhas — clinica + membership admin — na MESMA transacao. Ou nasce
-- inteiro, ou nada nasce: nunca uma clinica sem dono.
-- =============================================================================

create or replace function public.create_clinic_with_owner(p_name text)
returns public.clinics
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_name    text := btrim(coalesce(p_name, ''));
  v_clinic  public.clinics;
begin
  -- Sem sessao nao ha dono possivel.
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED: e necessario estar autenticado.'
      using errcode = '42501';
  end if;

  -- Mesma regra do CHECK da coluna e do schema zod em packages/shared.
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'CLINIC_NAME_INVALID: o nome da clinica deve ter entre 2 e 120 caracteres.'
      using errcode = '22023';
  end if;

  -- created_by vem SEMPRE de auth.uid(), nunca de parametro: o chamador nao
  -- escolhe de quem e a clinica.
  insert into public.clinics (name, created_by)
  values (v_name, v_user_id)
  returning * into v_clinic;

  insert into public.clinic_members (clinic_id, user_id, role)
  values (v_clinic.id, v_user_id, 'admin');

  return v_clinic;
end;
$$;

comment on function public.create_clinic_with_owner(text) is
  'Cria uma clinica e torna o usuario autenticado admin dela, atomicamente. Unico caminho de criacao de clinica.';

-- O default do Postgres concede EXECUTE a PUBLIC. Explicitamente revogado:
-- so usuario autenticado cria clinica.
revoke all on function public.create_clinic_with_owner(text) from public, anon;
grant execute on function public.create_clinic_with_owner(text) to authenticated;
