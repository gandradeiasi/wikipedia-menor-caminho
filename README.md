# Menor Caminho na Wikipédia

Site estático, sem backend, que encontra o menor caminho de links entre dois artigos da Wikipédia em português. Tudo roda no navegador, usando a API pública da Wikipédia.

## Funcionalidades

- **Menor caminho** entre dois artigos, com busca em largura bidirecional.
- **Próximos caminhos:** o botão "Próximos Caminhos" mostra o 2º, o 3º caminho e assim por diante (até 5). Primeiro aparecem os outros caminhos de mesmo tamanho, depois os mais longos.
- **Artigos clicáveis:** cada artigo do caminho abre na Wikipédia em uma nova aba.
- **Autocompletar:** sugere artigos enquanto você digita (↑ ↓ para navegar, Enter para escolher, Esc para fechar).
- **Progresso em tempo real:** profundidade, artigos expandidos, artigos conhecidos, direção atual da busca e os últimos artigos explorados.
- **Direção da busca no resultado:**
  - azul com seta **→**: trecho encontrado pela busca que partiu da origem;
  - verde com seta **←**: trecho encontrado pela busca que partiu do destino;
  - dourado com **✦**: o ponto de encontro das duas buscas.

  A seta mostra a direção em que a busca andou, não a direção do link. O link real sempre vai do artigo da esquerda para o da direita, e isso aparece ao passar o mouse sobre a seta.
- **Log de depuração:** clique em "Mostrar Logs" para ver erros, avisos e um resumo de cada busca (tempo, artigos expandidos, requisições). "Copiar Log" copia tudo, junto com a versão do navegador.
- **Contador de buscas:** salvo no `localStorage`, conta só as buscas feitas neste navegador.
- **Visual:** mistura de Frutiger Aero (céu, bolhas, vidro, botões brilhantes) e GeoCities (letreiro, título arco-íris, contador estilo odômetro). As animações param se o sistema estiver com "reduzir movimento".
- **Responsivo:** no celular o caminho vira uma lista vertical, com setas ↓ (origem) e ↑ (destino).

## Como usar

1. Abra `index.html` no navegador. Não precisa de servidor nem de instalação.
2. Digite o artigo de origem e o de destino (ex.: Brasil → Mona Lisa).
3. Clique em **Buscar Caminho** ou pressione Enter.
4. Clique em **Próximos Caminhos** para ver alternativas, ou em **Nova Busca** para recomeçar.

Os nomes são validados antes da busca, e redirecionamentos são resolvidos (ex.: "futebol" vira "Futebol").

## Como a busca funciona

### Busca bidirecional

Uma busca parte da origem e segue os links de cada artigo (`prop=links`). A outra parte do destino e segue os artigos que apontam para ele (`prop=linkshere`). A cada rodada avança o lado com menos artigos pendentes, e a busca para quando os dois lados se encontram.

Cada artigo tem centenas de links, então explorar só a partir da origem multiplica o trabalho a cada nível. Com as duas pontas, cada lado só precisa percorrer cerca de metade da distância. Num caminho de 4 cliques, isso é a diferença entre dezenas de milhões e algumas centenas de artigos lidos.

Detalhes:

- **Teste de encontro na descoberta:** o encontro é detectado assim que um artigo é descoberto, sem esperar ele ser processado.
- **Todos os pais guardados:** cada artigo guarda todos os artigos do nível anterior que levam a ele. Isso permite listar todos os caminhos mínimos sem refazer a busca.
- **Só artigos:** `plnamespace=0` e `lhnamespace=0` ignoram categorias, predefinições, páginas de ajuda etc.

### Próximos caminhos

Os caminhos encontrados num mesmo encontro ficam guardados e são mostrados um por vez. Quando acabam, a busca recomeça ignorando os caminhos já mostrados e avança para caminhos mais longos. O cache de links fica em memória, então a nova busca reaproveita o que já foi baixado.

### Requisições à API

- **Lotes:** até 50 artigos por requisição (`titles=A|B|…`), seguindo as páginas de continuação da API.
- **Paralelismo:** até 6 lotes ao mesmo tempo.
- **Limite da Wikipédia (HTTP 429):** a Wikipédia limita rajadas de requisições anônimas. Quando isso acontece, todas as requisições pausam (respeitando o cabeçalho `Retry-After`) e o paralelismo cai pela metade. Depois de uma sequência de sucessos, ele volta a subir aos poucos.
- **Falhas:** timeout de 15s e até 5 tentativas por requisição. Se um artigo não puder ser carregado, a tela avisa que a busca ficou incompleta, em vez de dizer que não há caminho.

## Limites e configuração

Os valores ficam no topo de `script.js`:

| Constante | Valor | O que controla |
|---|---|---|
| `MAX_DEPTH` | 8 | Tamanho máximo do caminho, em cliques |
| `MAX_PATHS` | 5 | Quantos caminhos mostrar por busca |
| `MAX_EXPLORED` | 15000 | Artigos expandidos antes de desistir da busca principal |
| `MAX_EXPLORED_MORE` | 5000 | O mesmo limite, para "Próximos Caminhos" |
| `BATCH_SIZE` | 50 | Artigos por requisição |
| `MAX_BATCH_PAGES` | 40 | Páginas de continuação por lote (até 20.000 links) |
| `REQUEST_POOL_SIZE` | 6 | Lotes em paralelo |
| `REQUEST_TIMEOUT` | 15000 | Timeout de cada requisição, em ms |
| `MAX_RETRIES` | 5 | Tentativas por requisição |

## Limitações

- Só funciona com a Wikipédia em português.
- **Artigos muito citados:** artigos como "Futebol", "Brasil" ou datas têm dezenas de milhares de links de entrada. A lista é cortada no limite de `MAX_BATCH_PAGES`, então em casos raros um caminho mínimo pode ficar de fora. O log avisa quando há corte.
- **"Próximos Caminhos" entre dois artigos muito citados** pode demorar, porque qualquer direção exige ler milhares de links.
- **Limite da Wikipédia:** muitas buscas seguidas podem fazer a Wikipédia limitar o seu IP por alguns minutos. Nesse caso a busca fica lenta, e o log mostra "Wikipédia limitou as requisições… pausando Xs".
- **Redirecionamentos no caminho:** quando um artigo do meio do caminho é um redirecionamento, ele aparece com o nome do redirecionamento. O link abre o artigo certo.

## Estrutura do projeto

```
index.html   - Interface, estilos e marcação
script.js    - Busca, requisições à API, autocompletar, log e renderização
README.md    - Este arquivo
```

## Exemplos para testar

- Brasil → Mona Lisa
- Albert Einstein → Pizza
- Michael Jackson → Madame Underground Club
- Piseiro → As Duas Torres
- São Paulo → Marte
