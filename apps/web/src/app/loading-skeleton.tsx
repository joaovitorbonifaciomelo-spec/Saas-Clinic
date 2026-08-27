/**
 * Esqueleto de carregamento compartilhado.
 *
 * O Next mostra isto INSTANTANEAMENTE ao navegar, enquanto o server component
 * ainda busca dados. Sem ele, o clique fica sem resposta durante toda a
 * requisicao — que pelo Funnel custa ~330ms por ida e volta.
 *
 * Isso nao deixa a busca mais rapida: deixa a navegacao *responsiva*, que e o
 * que a pessoa percebe.
 *
 * Usa o MESMO cabecalho e a MESMA superficie das telas reais, entao o conteudo
 * aparece no lugar onde o esqueleto ja estava, sem salto.
 */
export function LoadingSkeleton({ title, rows = 4 }: { title: string; rows?: number }) {
  return (
    <div className="content" aria-busy="true" aria-live="polite">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="page-sub">Carregando…</p>
        </div>
      </div>
      <div className="card">
        <div className="card-body">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="sk sk-line" style={{ width: `${92 - i * 11}%` }} />
          ))}
        </div>
      </div>
    </div>
  )
}
