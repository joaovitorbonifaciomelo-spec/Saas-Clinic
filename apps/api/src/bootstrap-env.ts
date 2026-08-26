import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'

// Modulo de efeito colateral: importado ANTES de qualquer coisa que leia
// process.env. Isolado num arquivo proprio para que a ordem de execucao seja
// explicita, em vez de depender de onde o import de dotenv acabou parando.
//
// O caminho e resolvido a partir DESTE arquivo, nao do cwd: tanto src/ quanto
// dist/ ficam um nivel abaixo da raiz da app, entao `node dist/main.js` funciona
// de qualquer diretorio — inclusive dentro do container, onde o cwd nao e o
// mesmo do desenvolvimento.
loadDotenv({ path: resolve(__dirname, '..', '.env') })
