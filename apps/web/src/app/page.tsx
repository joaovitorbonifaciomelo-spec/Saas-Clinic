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

/*
 * Uma frase por card, nao um paragrafo.
 *
 * O conteudo e o mesmo de antes — nenhum recurso entrou ou saiu — mas o texto
 * longo fazia a secao parecer documentacao, e ninguem le documentacao numa
 * pagina de apresentacao. O detalhe fica para a demonstracao.
 */
const RECURSOS = [
  {
    Icon: IconToday,
    titulo: 'Hoje',
    texto:
      'Quantas consultas o dia tem, quais já estão confirmadas e o que vem a seguir.',
  },
  {
    Icon: IconCalendar,
    titulo: 'Agenda',
    texto:
      'Grade por dia e semana, uma coluna por profissional. Encaixes aparecem lado a lado.',
  },
  {
    Icon: IconUsers,
    titulo: 'Pacientes',
    texto: 'Telefone, convênio, próxima consulta e o histórico completo de cada pessoa.',
  },
  {
    Icon: IconStethoscope,
    titulo: 'Profissionais',
    texto: 'Especialidade e faixas de atendimento por dia da semana, usadas pela agenda.',
  },
  {
    Icon: IconTag,
    titulo: 'Serviços',
    texto: 'A duração de cada serviço calcula o horário de término ao marcar.',
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
            <a href="#seguranca">Proteção de dados</a>
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

              {/* Mesma linguagem da secao de protecao de dados: a recepcao nao
                  precisa saber onde a regra roda, precisa saber que os dados da
                  clinica dela ficam com ela. */}
              <p className="lp-trust">
                <IconShield />
                Os dados de cada clínica ficam separados e protegidos por controles de acesso.
              </p>
            </div>

            {/*
              Captura real do sistema, nao mockup ilustrativo: a Agenda como ela
              esta hoje, com dados de exemplo. Um dashboard fictico bonito aqui
              viraria decepcao na primeira demonstracao.

              A Agenda no lugar da tela Hoje porque ela e densa de cima a baixo.
              A Hoje termina em area vazia, e dentro da moldura esse vazio virava
              um retangulo branco enorme — o oposto do que a secao precisa.
            */}
            <div className="lp-hero-art" aria-hidden="false">
              <figure className="lp-frame">
                <div className="lp-frame-bar">
                  <span />
                  <span />
                  <span />
                </div>
                <img
                  src="/produto-agenda.webp"
                  alt="Tela Agenda do sistema: grade de horários com uma coluna por profissional, consultas posicionadas pela duração e status indicado por cor."
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
                  {/* Icone e titulo na mesma linha: o olho pega os cinco nomes
                      numa varredura so, sem descer e subir a cada card. */}
                  <div className="lp-card-top">
                    <span className="lp-card-icon">
                      <Icon size={17} />
                    </span>
                    <h3>{titulo}</h3>
                  </div>
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

        {/*
          Esta secao fala com quem administra uma clinica, nao com quem escreve
          codigo. O mecanismo continua descrito — mas em uma linha discreta
          embaixo de cada item, nao como titulo. Quem quiser conferir a
          engenharia encontra; quem so quer saber se os dados estao separados le
          a primeira frase e ja tem a resposta.

          Nada de "seguranca total" ou "impossivel acessar": promessa absoluta
          sobre seguranca e a mais facil de quebrar.
        */}
        <section id="seguranca" className="lp-sec">
          <div className="lp-wrap lp-sec-inner">
            <div>
              <span className="lp-eyebrow dark">Proteção de dados</span>
              <h2 className="lp-h2 dark">Os dados da sua clínica ficam só com a sua clínica</h2>
              <p className="lp-sec-lead">
                Os dados de cada clínica ficam separados e protegidos por controles de acesso. A
                separação não depende de a tela lembrar de filtrar: ela é aplicada antes, no próprio
                banco de dados.
              </p>
            </div>

            <ul className="lp-sec-list">
              <li>
                <IconShield size={17} />
                <div>
                  <strong>Cada clínica vê apenas o que é dela</strong>
                  <span>
                    Pacientes, agenda e profissionais de uma clínica não aparecem para nenhuma
                    outra.
                  </span>
                  <span className="lp-sec-tech">Row Level Security no PostgreSQL</span>
                </div>
              </li>
              <li>
                <IconUsers size={17} />
                <div>
                  <strong>Só quem é da equipe entra</strong>
                  <span>
                    O acesso é confirmado no servidor contra a lista real de pessoas ligadas à
                    clínica, não pelo que o navegador informa.
                  </span>
                  <span className="lp-sec-tech">Vínculo verificado a cada requisição</span>
                </div>
              </li>
              <li>
                <IconCheck size={17} />
                <div>
                  <strong>Conferido a cada atualização</strong>
                  <span>
                    Testes automáticos verificam essa separação sempre que o sistema muda — não
                    ficamos no “deve estar funcionando”.
                  </span>
                  <span className="lp-sec-tech">Bateria de testes de isolamento</span>
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
          <p>Produto em fase de validação.</p>
          <nav aria-label="Acesso">
            <Link href="/login">Entrar</Link>
            <Link href="/signup">Criar conta</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
