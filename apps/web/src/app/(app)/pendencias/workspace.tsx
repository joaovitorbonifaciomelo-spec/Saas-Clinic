'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ClinicMemberSummary, Page, TaskDetail, TaskEventView, TaskListItem, TaskView } from '@clinicas/shared'
import { Lista } from './lista'
import { PendenciaDrawer } from './pendencia-drawer'
import { NovaPendencia } from './nova-pendencia'

/**
 * Caixa operacional de Pendencias, em DUAS partes: a lista (sempre visivel) e
 * o drawer (sobreposto, so quando algo esta selecionado ou sendo criado).
 *
 * Diferente do Atendimento, nao ha uma terceira area fixa de contexto: aqui o
 * contexto (paciente/conversa/agendamento) cabe inteiro dentro do proprio
 * drawer da pendencia, entao o layout de 3 colunas seria espaco gasto sem
 * motivo. O `.drawer` overlay ja resolve mobile sozinho (vira tela cheia),
 * sem precisar da logica de "uma area por vez" que o Atendimento tem.
 */
export function PendenciasWorkspace({
  visao,
  lista,
  pendencia,
  eventos,
  eventosFalhou,
  equipe,
  timezone,
}: {
  visao: TaskView
  lista: Page<TaskListItem>
  pendencia: TaskDetail | null
  eventos: Page<TaskEventView>
  eventosFalhou: boolean
  equipe: ClinicMemberSummary[]
  timezone: string
}) {
  const router = useRouter()
  const [novaAberta, setNovaAberta] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  /*
   * Atualizacao discreta ao voltar para a aba. Sem polling, sem realtime —
   * nada aqui promete tempo real. E o momento em que quem volta de outra
   * tarefa naturalmente reavalia a fila.
   */
  useEffect(() => {
    const aoFocar = () => router.refresh()
    window.addEventListener('focus', aoFocar)
    return () => window.removeEventListener('focus', aoFocar)
  }, [router])

  /** Aviso humano de conflito/estado invalido. Some sozinho. */
  useEffect(() => {
    if (!aviso) return
    const t = setTimeout(() => setAviso(null), 6000)
    return () => clearTimeout(t)
  }, [aviso])

  function fecharDrawer(): void {
    router.push(`/pendencias${visao !== 'today' ? `?v=${visao}` : ''}`, { scroll: false })
  }

  return (
    <div className="pd-shell">
      {aviso ? (
        <div className="pd-aviso" role="status">
          {aviso}
        </div>
      ) : null}

      <Lista
        itens={lista.items}
        proximoCursor={lista.nextCursor}
        selecionadaId={pendencia?.id}
        visao={visao}
        timezone={timezone}
        onNova={() => setNovaAberta(true)}
        onAviso={setAviso}
      />

      {pendencia ? (
        <PendenciaDrawer
          pendencia={pendencia}
          eventos={eventos}
          eventosFalhou={eventosFalhou}
          equipe={equipe}
          timezone={timezone}
          onFechar={fecharDrawer}
          onAviso={setAviso}
        />
      ) : null}

      {novaAberta ? (
        <NovaPendencia
          equipe={equipe}
          timezone={timezone}
          onFechar={() => setNovaAberta(false)}
          onCriada={(id) => {
            setNovaAberta(false)
            router.push(`/pendencias?${visao !== 'today' ? `v=${visao}&` : ''}id=${id}`, {
              scroll: false,
            })
          }}
        />
      ) : null}
    </div>
  )
}
