-- =============================================================================
-- 0019 - o trigger de occurred_at nao pode depender do privilegio de quem insere
--
-- CORRIGE a 0018, que ja esta aplicada e por isso nao e editada.
--
-- O QUE ACONTECEU: a 0018 criou `reject_future_occurred_at` sem SECURITY
-- DEFINER. Trigger comum executa com os privilegios de quem disparou o INSERT.
-- Como o predicado `message_occurred_at_ok` foi revogado de todos os papeis (a
-- politica do projeto e lista positiva), qualquer insercao vinda de fora de uma
-- funcao SECURITY DEFINER falhava com:
--
--     permission denied for function message_occurred_at_ok
--
-- O caminho normal nao mostrava o problema: `conversation_add_manual_message` e
-- SECURITY DEFINER, entao dentro dela o usuario efetivo e o dono e a chamada
-- passava. Quem revelou foi um teste que insere como `service_role` — o mesmo
-- caminho que um adaptador de provedor usaria amanha.
--
-- POR QUE ISSO IMPORTA ALEM DA MENSAGEM FEIA: a insercao falhava, sim, entao
-- nao houve brecha. Mas falhava pelo motivo ERRADO. Uma mensagem com
-- `occurred_at` perfeitamente valido tambem seria recusada, e o erro nao diria
-- nada sobre a regra real. Invariante de dados tem que valer igual para todo
-- caminho de escrita, e a resposta tem que ser sobre o dado, nao sobre grants.
--
-- A ALTERNATIVA DESCARTADA: conceder EXECUTE do predicado a public. Ele e puro
-- e nao revela nada — mas ampliar a superficie para resolver um problema de
-- contexto de execucao contraria a lista positiva que as 0016/0017
-- estabeleceram. O trigger passa a rodar como dono, e o predicado continua
-- fechado.
--
-- SECURITY DEFINER aqui NAO afeta `auth.uid()`: ela le a claim do JWT, nao o
-- usuario de sessao. E este trigger nao consulta identidade nenhuma — compara
-- um timestamp com o relogio do servidor.
-- =============================================================================

create or replace function public.reject_future_occurred_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.message_occurred_at_ok(new.occurred_at) then
    raise exception 'MESSAGE_OCCURRED_AT_IN_FUTURE: occurred_at nao pode estar no futuro.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

-- O default do PostgreSQL concede EXECUTE a PUBLIC em toda funcao nova, e
-- `create or replace` de uma funcao que ja existia preserva os privilegios
-- atuais — mas repetimos o revoke para que este arquivo nao dependa do que a
-- 0018 deixou para tras.
revoke execute on function public.reject_future_occurred_at()
  from public, anon, authenticated;
