'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type {
  ClinicMemberSummary,
  ConversationDetail,
  ConversationEventView,
  ConversationListItem,
  Message,
  Page,
} from '@clinicas/shared'
import type { VisaoFila } from './visoes'
import { Fila } from './fila'
import { Thread } from './thread'
import { PainelContexto } from './painel-contexto'
import { NovoAtendimento } from './novo-atendimento'

/**
 * Caixa operacional em tres areas.
 *
 * Desktop: fila | conversa | contexto.
 * Tablet:  fila | conversa, contexto em gaveta.
 * Mobile:  uma area por vez — a de baixo entra por cima, nao espremida.
 *
 * O estado que importa (conversa selecionada, visao, busca) vive na URL. O que
 * fica aqui e so estado de TELA: gaveta aberta, aviso de conflito, painel novo.
 */
export function AtendimentoWorkspace({
  visao,
  busca,
  fila,
  conversa,
  conversaNaUrl,
  mensagens,
  eventos,
  equipe,
  timezone,
}: {
  visao: VisaoFila
  busca: string
  fila: Page<ConversationListItem>
  conversa: ConversationDetail | null
  /** A conversa veio de `?c=` na URL, e nao da auto-selecao da primeira. */
  conversaNaUrl: boolean
  mensagens: Page<Message>
  eventos: Page<ConversationEventView>
  equipe: ClinicMemberSummary[]
  timezone: string
}) {
  const router = useRouter()
  const [novoAberto, setNovoAberto] = useState(false)
  const [contextoAberto, setContextoAberto] = useState(false)
  /*
   * Em telas estreitas, qual area esta visivel. Ignorado no desktop.
   *
   * So abre direto na conversa quando ela veio da URL — alguem clicou num link
   * ou voltou para onde estava. A auto-selecao da primeira da fila existe para
   * o desktop nao ter painel vazio ao lado; no celular ela pularia a fila
   * inteira e jogaria a pessoa numa conversa que ela nao pediu.
   */
  const [areaMobile, setAreaMobile] = useState<'fila' | 'conversa'>(
    conversaNaUrl ? 'conversa' : 'fila',
  )
  const [aviso, setAviso] = useState<string | null>(null)

  /*
   * Atualizacao discreta ao voltar para a aba.
   *
   * NAO ha polling nem realtime — nada aqui promete tempo real. Quem saiu para
   * atender no balcao e voltou merece ver a fila de agora, e esse e o momento
   * em que a pessoa naturalmente reavalia a tela.
   */
  useEffect(() => {
    const aoFocar = () => router.refresh()
    window.addEventListener('focus', aoFocar)
    return () => window.removeEventListener('focus', aoFocar)
  }, [router])

  /** Aviso humano de conflito, sem numero de versao. Some sozinho. */
  useEffect(() => {
    if (!aviso) return
    const t = setTimeout(() => setAviso(null), 6000)
    return () => clearTimeout(t)
  }, [aviso])

  function abrirConversa(): void {
    setAreaMobile('conversa')
    setContextoAberto(false)
  }

  return (
    <div className="at-shell" data-area={areaMobile}>
      {aviso ? (
        <div className="at-aviso" role="status">
          {aviso}
        </div>
      ) : null}

      <Fila
        itens={fila.items}
        proximoCursor={fila.nextCursor}
        selecionadaId={conversa?.id}
        visao={visao}
        busca={busca}
        timezone={timezone}
        onAbrir={abrirConversa}
        onNovo={() => setNovoAberto(true)}
      />

      <Thread
        conversa={conversa}
        mensagens={mensagens}
        eventos={eventos}
        equipe={equipe}
        timezone={timezone}
        onAviso={setAviso}
        onVoltar={() => setAreaMobile('fila')}
        onAbrirContexto={() => setContextoAberto(true)}
      />

      <PainelContexto
        conversa={conversa}
        timezone={timezone}
        aberto={contextoAberto}
        onFechar={() => setContextoAberto(false)}
        onAviso={setAviso}
      />

      {novoAberto ? (
        <NovoAtendimento
          onFechar={() => setNovoAberto(false)}
          onCriada={(id, criada) => {
            setNovoAberto(false)
            setAreaMobile('conversa')
            if (!criada) {
              // Nao e erro: o telefone ja tinha thread e abrimos a existente.
              setAviso('Já existia um atendimento para este telefone. Abrimos ele.')
            }
            router.push(`/atendimento?c=${id}`, { scroll: false })
          }}
        />
      ) : null}
    </div>
  )
}
