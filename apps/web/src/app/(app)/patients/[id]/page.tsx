import { redirect } from 'next/navigation'

/**
 * Rota antiga de detalhe do paciente.
 *
 * A ficha agora vive em /patients?p=<id>, ao lado da lista (master-detail).
 * Este redirect existe para que links antigos, favoritos e o botao de voltar do
 * navegador continuem chegando ao lugar certo em vez de num 404.
 */
export default async function PatientRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/patients?p=${id}`)
}
