# Menor Caminho na Wikipédia

Um site estático que encontra o caminho mais curto entre dois artigos da Wikipédia em português, usando algoritmo BFS (Busca em Largura).

## Funcionalidades

- 🔍 **Busca de Caminhos**: Encontra o caminho mais curto entre dois artigos
- 📊 **Múltiplos Caminhos**: Clique em "Próximos Caminhos" para encontrar o segundo, terceiro caminho, etc
- 🔗 **Links Clicáveis**: Todos os artigos no caminho são clicáveis e abrem na Wikipédia em nova aba
- ⚡ **Sem Backend**: Funciona 100% no navegador usando a API pública da Wikipédia
- 📱 **Responsivo**: Funciona em desktop e dispositivos móveis

## Como Usar

1. Abra `index.html` no navegador
2. Digite o artigo de origem (ex: Brasil)
3. Digite o artigo de destino (ex: Mona Lisa)
4. Clique em "Buscar Caminho"
5. O caminho mais curto será exibido
6. Clique em "Próximos Caminhos" para encontrar caminhos alternativos
7. Clique em qualquer artigo para abrir na Wikipédia

## Algoritmo

O site usa **BFS Bidirecional otimizado** para encontrar caminhos mais rápido:

### Otimizações Implementadas

1. **BFS Bidirecional** - Busca dos dois lados simultaneamente, reduzindo o espaço de busca exponencialmente (~2·b^(d/2) em vez de b^d)
2. **Pool de Requisições Concorrentes** - Até 6 requisições paralelas em vez de sequenciais, reduzindo latência de rede
3. **Links Completos** - Implementa `plcontinue` e `lhcontinue` para obter todos os links (não apenas 500)
4. **Namespace Filtrado** - Usa `plnamespace=0` e `lhnamespace=0` para ignorar categorias, predefinições, etc.
5. **Enumeração de Múltiplos Caminhos** - Armazena todos os pais/filhos no DAG para enumerar todos os caminhos de mesmo tamanho sem refazer buscas
6. **Teste de Objetivo na Descoberta** - Detecta encontro assim que o nó é descoberto, não ao ser desenfileirado

### Estratégia de Caminhos

- **Primeiro Caminho**: BFS bidirecional encontra o caminho ótimo rapidamente
- **Próximos Caminhos**: Enumera outros caminhos de mesmo tamanho a partir do DAG (custo zero de rede)
- **Se esgotarem**: Volta a buscar com bloqueio de arestas e cache em memória

- **Limite de Profundidade**: Máximo de 6 níveis de profundidade
- **Limite de Caminhos**: Até 5 caminhos diferentes

## Limitações

- Busca apenas na Wikipédia em português
- Limite de profundidade de 6 níveis (pode ajustar em `MAX_DEPTH`)
- Máximo de 5 caminhos por busca (pode ajustar em `MAX_PATHS`)
- Pode levar alguns segundos dependendo da conexão
- Alguns artigos podem não ser alcançáveis dependendo dos links disponíveis

## Estrutura do Projeto

```
index.html      - Página principal com formulário e interface
script.js       - Lógica de pathfinding e requisições à API
README.md       - Este arquivo
```

## Notas Técnicas

- Usa a API pública da Wikipédia com suporte a CORS
- Cache de links em memória para evitar requisições desnecessárias
- Normalização de nomes de artigos para consistência
- Interface responsiva com CSS Grid e Flexbox

## Exemplos de Buscas Interessantes

- Brasil → Mona Lisa
- Albert Einstein → Pizza
- São Paulo → Marte
- Futebol → Música
- Covid-19 → Dinossauro
