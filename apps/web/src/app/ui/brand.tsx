import { IconCross } from './icons'

/**
 * Marca do produto.
 *
 * PROVISORIA. Nao existe nome definitivo aprovado: este e um wordmark neutro,
 * herdado do escopo dos pacotes (@clinicas/*) e do title que ja estava no
 * layout raiz. Esta aqui como constante unica de proposito — quando o nome for
 * decidido, muda-se uma linha e a landing, o login, o signup e o <title>
 * acompanham juntos.
 *
 * O simbolo e a mesma cruz abstrata que a sidebar do sistema ja usa, entao as
 * telas publicas e o produto interno se leem como a mesma coisa.
 */
export const PRODUCT_NAME = 'Clínicas'

export function Wordmark({
  size = 'md',
  tone = 'light',
}: {
  size?: 'md' | 'lg'
  tone?: 'light' | 'dark'
}) {
  return (
    <span className={`wordmark ${size} ${tone}`}>
      <span className="wordmark-mark">
        <IconCross size={size === 'lg' ? 20 : 16} />
      </span>
      <span className="wordmark-text">{PRODUCT_NAME}</span>
    </span>
  )
}
