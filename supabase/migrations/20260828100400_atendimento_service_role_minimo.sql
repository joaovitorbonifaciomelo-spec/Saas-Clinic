-- =============================================================================
-- 0016 - service_role no minimo explicito (corrige a 0015)
--
-- A 0015 usou `grant all`, e `all` em tabela nao e um conjunto abstrato: ele
-- expande para os sete privilegios que a tabela suporta. Verificado no Dev logo
-- depois, `service_role` tinha TRUNCATE, REFERENCES e TRIGGER nas tres tabelas
-- sem que nenhuma linha do projeto tivesse pedido isso.
--
-- A 0015 JA FOI APLICADA no remoto. Por isso esta migration e ADITIVA: revoga o
-- excedente e reafirma os quatro desejados, em vez de reescrever o arquivo ja
-- aplicado. Editar migration aplicada deixaria o historico local dizendo uma
-- coisa e o banco outra — e o proximo a ler o repositorio acreditaria no
-- arquivo.
--
-- POR QUE OS TRES INCOMODAM, mesmo em papel administrativo:
--
--   TRUNCATE  - nao e coberto por RLS e nao dispara trigger de linha. Um
--               truncate apaga os dados de TODOS os tenants sem violar policy
--               nenhuma e sem deixar rastro nos eventos. E o unico verbo capaz
--               de esvaziar o Atendimento inteiro numa instrucao. Nada no
--               projeto trunca: o teardown apaga `clinics` e deixa a cascata
--               levar conversas, mensagens e eventos junto.
--   REFERENCES- permite apontar FK nova para estas tabelas. As FKs compostas
--               tenant-first sao criadas pelo dono na 0012, e uma FK criada
--               fora dali poderia amarrar linhas de tenants diferentes.
--   TRIGGER   - permite anexar gatilho. Os triggers destas tabelas SAO a regra
--               de negocio (carimbo de autoria, versao, transicao de status);
--               poder acrescentar outro por fora e poder reescrever a regra.
--
-- Nenhum deles e necessario para o uso atual. `service_role` existe so no
-- .env.test, para setup e teardown dos testes, e isso se faz com os quatro
-- verbos de DML. Se um dia algum uso exigir mais, o pedido tem que vir com a
-- operacao concreta que falhou — nao com "para garantir".
--
-- REVOKE e por privilegio nomeado, nao `revoke all`, para nao derrubar junto os
-- quatro que queremos manter e depender da ordem das instrucoes.
-- =============================================================================

revoke truncate, references, trigger on public.conversations       from service_role;
revoke truncate, references, trigger on public.messages            from service_role;
revoke truncate, references, trigger on public.conversation_events from service_role;

-- Reafirmados explicitamente: esta migration passa a ser a resposta completa a
-- "o que service_role pode fazer no Atendimento?", sem depender da 0015.
grant select, insert, update, delete on public.conversations       to service_role;
grant select, insert, update, delete on public.messages            to service_role;
grant select, insert, update, delete on public.conversation_events to service_role;
