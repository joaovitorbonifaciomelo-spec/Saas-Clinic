/**
 * Esqueleto de carregamento compartilhado.
 *
 * O Next mostra isto INSTANTANEAMENTE ao navegar, enquanto o server component
 * ainda busca dados. Sem ele, o clique fica sem resposta durante toda a
 * requisicao — que pelo Funnel custa ~330ms por ida e volta.
 *
 * Isso nao deixa a busca mais rapida: deixa a navegacao *responsiva*, que e o
 * que a pessoa percebe.
 */
export function LoadingSkeleton({ title, rows = 4 }: { title: string; rows?: number }) {
  return (
    <main className="container" aria-busy="true" aria-live="polite">
      <div className="row">
        <h1>{title}</h1>
        <span className="muted">Carregando…</span>
      </div>
      <div className="card">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton-line" style={{ width: `${92 - i * 11}%` }} />
        ))}
      </div>
    </main>
  )
}
