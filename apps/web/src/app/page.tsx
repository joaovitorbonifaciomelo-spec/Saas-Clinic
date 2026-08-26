import type { Metadata } from 'next'
import Link from 'next/link'
import { PRODUCT_NAME, Wordmark } from './ui/brand'
import {
  IconCalendar,
  IconCheck,
  IconClock,
  IconShield,
  IconStethoscope,
  IconTag,
  IconToday,
  IconUsers,
} from './ui/icons'

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — agenda, pacientes e profissionais da clínica em um só lugar`,
  description:
    'Sistema para a recepção da clínica: veja o dia, marque e remarque consultas, ' +
    'acompanhe o status de cada agendamento e mantenha pacientes, profissionais e ' +
    'serviços no mesmo lugar.',
  /*
   * Sem `canonical` por enquanto. Sem `metadataBase`, o Next emite a URL
   * relativa ("/"), e a alternativa seria fixar o dominio temporario da Vercel
   * no codigo — apontar canonical para um endereco que vai mudar e pior do que
   * nao ter canonical nenhum. Volta junto com o dominio proprio.
   */
}

/*
 * Landing publica.
 *
 * Regra que governa TODO o texto desta pagina: so entra afirmacao sobre coisa
 * que ja existe e funciona no produto. Nada de "reduz faltas em X%", WhatsApp,
 * financeiro, prontuario, relatorios, IA, integracoes, numero de clientes ou
 * depoimento. Estamos em validacao com piloto; prova social inventada seria
 * mentira antes mesmo da primeira venda — e a primeira clinica que entrar vai
 * comparar a promessa com a tela.
 *
 * Server component estatico: sem estado, sem efeito, sem biblioteca de
 * animacao. O unico peso sao duas imagens WebP do proprio sistema.
 */

const RECURSOS = [
  {
    Icon: IconToday,
    titulo: 'Hoje',
    texto:
      'A tela de abertura da recepção: quantas consultas o dia tem, quais já estão confirmadas, quais ainda aguardam resposta e o que vem a seguir.',
  },
  {
    Icon: IconCalendar,
    titulo: 'Agenda',
    texto:
      'Grade por dia e por semana, com uma coluna por profissional. Duração vira altura, buraco na agenda vira buraco na tela, e encaixes aparecem lado a lado em vez de se cobrirem.',
  },
  {
    Icon: IconUsers,
    titulo: 'Pacientes',
    texto:
      'Cadastro com telefone, nascimento e convênio, a próxima consulta em destaque e o histórico completo de agendamentos de cada pessoa.',
  },
  {
    Icon: IconStethoscope,
    titulo: 'Profissionais',
    texto:
      'Cada profissional com sua especialidade e suas faixas de atendimento por dia da semana — a agenda usa isso para mostrar o que está dentro e o que está fora do horário.',
  },
  {
    Icon: IconTag,
    titulo: 'Serviços',
    texto:
      'Defina os serviços da clínica e a duração de cada um. Ao marcar, o horário de término já vem calculado.',
  },
] as const

const PASSOS = [
  {
    titulo: 'Cadastre profissionais e serviços',
    texto:
      'Especialidade, faixas de atendimento por dia da semana e a duração de cada tipo de consulta.',
  },
  {
    titulo: 'Marque na grade',
    texto:
      'Clique num horário vago e o agendamento já abre no dia, na hora e no profissional daquela coluna. Conflito e horário fora da faixa são avisados na hora, e a decisão continua sendo de quem está no balcão.',
  },
  {
    titulo: 'Acompanhe o dia',
    texto:
      'Agendado, aguardando confirmação, confirmado, reagendamento solicitado, realizado, falta ou cancelado — o status fica na grade, com cor e forma.',
  },
] as const

export default function LandingPage() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-inner">
          <Link href="/" className="lp-nav-brand" aria-label={`${PRODUCT_NAME} — início`}>
            <Wordmark tone="dark" />
          </Link>

          {/* Somente ancoras que existem nesta pagina. Link de menu que nao leva
              a lugar nenhum e promessa quebrada a cada clique. */}
          <nav className="lp-nav-links" aria-label="Seções desta página">
            <a href="#recursos">Recursos</a>
            <a href="#como-funciona">Como funciona</a>
            <a href="#seguranca">Isolamento de dados</a>
          </nav>

          <div className="lp-nav-actions">
            <Link href="/login" className="lp-nav-login">
              Entrar
            </Link>
            <Link href="/signup" className="btn">
              Criar conta
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-inner">
            <div className="lp-hero-copy">
              <span className="lp-chip">Sistema de agenda para clínicas</span>

              <h1 className="lp-h1">
                Toda a agenda da clínica.
                <br />
                Pacientes e profissionais.
                <br />
                <span className="accent">Em uma tela só.</span>
              </h1>

              <p className="lp-lead">
                Um sistema para a recepção usar o dia inteiro: veja o dia, marque, remarque e
                acompanhe o status de cada agendamento — sem planilha paralela e sem caderno de
                horários.
              </p>

              <ul className="lp-mini">
                <li>
                  <IconCalendar />
                  <div>
                    <strong>Agenda por dia e semana</strong>
                    <span>Conflitos e encaixes visíveis.</span>
                  </div>
                </li>
                <li>
                  <IconUsers />
                  <div>
                    <strong>Pacientes centralizados</strong>
                    <span>Ficha e histórico juntos.</span>
                  </div>
                </li>
                <li>
                  <IconStethoscope />
                  <div>
                    <strong>Profissionais e horários</strong>
                    <span>Faixas de atendimento por dia.</span>
                  </div>
                </li>
                <li>
                  <IconClock />
                  <div>
                    <strong>Status do agendamento</strong>
                    <span>Do agendado ao realizado.</span>
                  </div>
                </li>
              </ul>

              <div className="lp-hero-cta">
                <Link href="/signup" className="btn lp-btn-lg">
                  Criar conta
                </Link>
                <Link href="/login" className="btn secondary lp-btn-lg">
                  Entrar
                </Link>
              </div>

              <p className="lp-trust">
                <IconShield />
                Cada clínica enxerga apenas os próprios dados. O isolamento é aplicado no banco, não
                na tela.
              </p>
            </div>

            {/*
              Captura real do sistema, nao mockup ilustrativo. As telas abaixo
              sao exatamente Hoje (desktop) e Agenda (celular) como estao hoje,
              com dados de exemplo. Um dashboard fictico bonito aqui viraria
              decepcao na primeira demonstracao.
            */}
            <div className="lp-hero-art" aria-hidden="false">
              <figure className="lp-frame">
                <div className="lp-frame-bar">
                  <span />
                  <span />
                  <span />
                </div>
                <img
                  src="/produto-hoje.webp"
                  alt="Tela Hoje do sistema: indicadores das consultas do dia, agenda do dia em ordem cronológica e lista de profissionais ativos."
                  width={1520}
                  height={950}
                  fetchPriority="high"
                  decoding="async"
                />
              </figure>
              <figure className="lp-phone">
                <img
                  src="/produto-agenda-mobile.webp"
                  alt="A mesma agenda no celular: grade de horários com uma coluna por profissional."
                  width={480}
                  height={1039}
                  loading="lazy"
                  decoding="async"
                />
              </figure>
            </div>
          </div>
        </section>

        <section id="recursos" className="lp-section">
          <div className="lp-wrap">
            <div className="lp-head">
              <span className="lp-eyebrow">O que o sistema faz hoje</span>
              <h2 className="lp-h2">Cinco módulos, nenhuma promessa a mais</h2>
              <p className="lp-sub">
                Esta lista é o produto inteiro. Não há aba vazia esperando para ser preenchida.
              </p>
            </div>

            <div className="lp-cards">
              {RECURSOS.map(({ Icon, titulo, texto }) => (
                <article key={titulo} className="lp-card">
                  <span className="lp-card-icon">
                    <Icon size={18} />
                  </span>
                  <h3>{titulo}</h3>
                  <p>{texto}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="como-funciona" className="lp-section alt">
          <div className="lp-wrap">
            <div className="lp-head">
              <span className="lp-eyebrow">Como funciona</span>
              <h2 className="lp-h2">Três passos, do cadastro ao dia rodando</h2>
            </div>

            <ol className="lp-steps">
              {PASSOS.map(({ titulo, texto }, i) => (
                <li key={titulo}>
                  <span className="lp-step-n tabular">{String(i + 1).padStart(2, '0')}</span>
                  <h3>{titulo}</h3>
                  <p>{texto}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="seguranca" className="lp-sec">
          <div className="lp-wrap lp-sec-inner">
            <div>
              <span className="lp-eyebrow dark">Isolamento de dados</span>
              <h2 className="lp-h2 dark">Uma clínica nunca alcança os dados de outra</h2>
              <p className="lp-sec-lead">
                O sistema é multi-clínica, e a separação não depende de a interface se lembrar de
                filtrar. Ela é imposta pelo próprio banco de dados, uma camada abaixo da aplicação.
              </p>
            </div>

            <ul className="lp-sec-list">
              <li>
                <IconShield size={17} />
                <div>
                  <strong>Row Level Security no PostgreSQL</strong>
                  <span>
                    Cada consulta roda com a identidade de quem está logado. Uma linha de outra
                    clínica simplesmente não existe para aquela sessão.
                  </span>
                </div>
              </li>
              <li>
                <IconUsers size={17} />
                <div>
                  <strong>Vínculo verificado a cada requisição</strong>
                  <span>
                    A clínica ativa é confirmada contra os vínculos reais do usuário no servidor —
                    nunca aceita apenas porque veio do navegador.
                  </span>
                </div>
              </li>
              <li>
                <IconCheck size={17} />
                <div>
                  <strong>Testado, não presumido</strong>
                  <span>
                    O isolamento entre clínicas é verificado por uma bateria de testes automatizados
                    a cada mudança.
                  </span>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section className="lp-cta">
          <div className="lp-wrap lp-cta-inner">
            <div>
              <h2 className="lp-h2">Organize a rotina da sua clínica em um só lugar.</h2>
              <p className="lp-sub">
                Crie sua conta, cadastre a clínica e comece pela agenda da semana.
              </p>
            </div>
            <div className="lp-cta-actions">
              <Link href="/signup" className="btn lp-btn-lg">
                Criar conta
              </Link>
              <Link href="/login" className="btn secondary lp-btn-lg">
                Entrar
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-inner">
          <Wordmark tone="dark" />
          <p>Produto em validação com clínicas piloto.</p>
          <nav aria-label="Acesso">
            <Link href="/login">Entrar</Link>
            <Link href="/signup">Criar conta</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
