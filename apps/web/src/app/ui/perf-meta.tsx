import { cookies } from 'next/headers'
import { perfSummary } from '../../lib/perf'

/**
 * Emite as duracoes do render num <meta>, e SOMENTE quando o cookie
 * `perf_debug` esta presente.
 *
 * Fica no fim do JSX de cada pagina de proposito: o React so renderiza este
 * componente depois que a funcao da pagina retornou, entao as marcas das buscas
 * daquela pagina ja estao registradas. Se estivesse no layout, seria avaliado
 * junto com os filhos e sairia vazio.
 */
export async function PerfMeta() {
  const store = await cookies()
  if (store.get('perf_debug')?.value !== '1') return null
  return <meta name="x-perf" content={perfSummary()} />
}
