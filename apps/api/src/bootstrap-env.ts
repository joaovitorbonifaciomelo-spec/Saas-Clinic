import { config as loadDotenv } from 'dotenv'

// Modulo de efeito colateral: importado ANTES de qualquer coisa que leia
// process.env. Isolado num arquivo proprio para que a ordem de execucao seja
// explicita, em vez de depender de onde o import de dotenv acabou parando.
loadDotenv()
