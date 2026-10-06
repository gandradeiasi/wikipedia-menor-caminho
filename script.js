const WIKI_API = 'https://pt.wikipedia.org/w/api.php';
const MAX_DEPTH = 8;
const MAX_PATHS = 5;
const SEARCH_DELAY = 300;
const MAX_SUGGESTIONS = 10;
const REQUEST_POOL_SIZE = 6;
const REQUEST_TIMEOUT = 15000;
const MAX_RETRIES = 5;
const BATCH_SIZE = 50;
const MAX_BATCH_PAGES = 40;
const CHUNK_SIZE = BATCH_SIZE * REQUEST_POOL_SIZE;
const MAX_EXPLORED = 15000;
const MAX_EXPLORED_MORE = 5000;
const RECENT_SIZE = 8;

class DebugLog {
    constructor(maxEntries = 500) {
        this.entries = [];
        this.maxEntries = maxEntries;
        this.container = null;
    }

    attach(container) {
        this.container = container;
        this.entries.forEach(entry => this.renderEntry(entry));
    }

    add(type, message) {
        const entry = { type, message: String(message), time: new Date().toLocaleTimeString('pt-BR') };
        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
            this.container?.firstChild?.remove();
        }
        this.renderEntry(entry);

        const consoleFn = type === 'error' ? console.error : type === 'warning' ? console.warn : console.log;
        consoleFn(`[${type}] ${entry.message}`);
    }

    renderEntry(entry) {
        const c = this.container;
        if (!c) return;

        const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 20;
        const icons = { error: '❌', warning: '⚠️', info: 'ℹ️', success: '✅' };

        const div = document.createElement('div');
        div.className = `debug-log-entry log-${entry.type}`;
        const time = document.createElement('span');
        time.className = 'debug-log-timestamp';
        time.textContent = `[${entry.time}]`;
        div.append(time, `${icons[entry.type] || '•'} ${entry.message}`);
        c.appendChild(div);

        if (atBottom) c.scrollTop = c.scrollHeight;
    }

    toText() {
        return this.entries.map(e => `[${e.time}] ${e.type.toUpperCase()}: ${e.message}`).join('\n');
    }

    error(message) { this.add('error', message); }
    warning(message) { this.add('warning', message); }
    info(message) { this.add('info', message); }
    success(message) { this.add('success', message); }
}

const debugLog = new DebugLog();

window.addEventListener('error', (event) => {
    debugLog.error(`Erro não tratado: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`);
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    debugLog.error(`Promise rejeitada sem tratamento: ${reason?.stack || reason?.message || reason}`);
});

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class RequestPool {
    constructor(maxConcurrent) {
        this.maxConcurrent = maxConcurrent;
        this.active = 0;
        this.waiting = [];
    }

    async execute(fn) {
        while (this.active >= this.maxConcurrent) {
            await new Promise(resolve => this.waiting.push(resolve));
        }
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }

    setLimit(limit) {
        this.maxConcurrent = limit;
        let freeSlots = this.maxConcurrent - this.active;
        while (freeSlots-- > 0 && this.waiting.length > 0) {
            this.waiting.shift()();
        }
    }
}

const requestPool = new RequestPool(REQUEST_POOL_SIZE);

// Wikipedia responde 429 a rajadas de requisições anônimas: pausa global + paralelismo adaptativo.
const throttle = {
    cooldownUntil: 0,
    backoff: 1000,
    successStreak: 0,

    async wait() {
        const delay = this.cooldownUntil - Date.now();
        if (delay > 0) await sleep(delay);
    },

    onRateLimited(retryAfterSeconds) {
        this.backoff = Math.min(this.backoff * 2, 30000);
        const pause = retryAfterSeconds ? retryAfterSeconds * 1000 : this.backoff;
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + pause);
        this.successStreak = 0;
        const newLimit = Math.max(1, Math.floor(requestPool.maxConcurrent / 2));
        if (newLimit !== requestPool.maxConcurrent) requestPool.setLimit(newLimit);
        debugLog.warning(`Wikipédia limitou as requisições (HTTP 429): pausando ${(pause / 1000).toFixed(1)}s, paralelismo agora ${requestPool.maxConcurrent}`);
    },

    onSuccess() {
        this.successStreak++;
        if (this.successStreak >= 20) {
            this.successStreak = 0;
            this.backoff = Math.max(1000, this.backoff / 2);
            if (requestPool.maxConcurrent < REQUEST_POOL_SIZE) requestPool.setLimit(requestPool.maxConcurrent + 1);
        }
    }
};

const apiStats = { requests: 0 };

async function apiGet(params, label) {
    const query = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
    const url = `${WIKI_API}?${query}`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        await throttle.wait();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        apiStats.requests++;

        try {
            const response = await fetch(url, { signal: controller.signal });

            if (response.status === 429) {
                throttle.onRateLimited(Number(response.headers.get('Retry-After')) || 0);
                const error = new Error('HTTP 429 Too Many Requests');
                error.rateLimited = true;
                throw error;
            }
            if (!response.ok) {
                const error = new Error(`HTTP ${response.status} ${response.statusText}`);
                error.retryable = response.status >= 500;
                throw error;
            }

            const data = await response.json();

            if (data.error) {
                const error = new Error(`API retornou erro ${data.error.code}: ${data.error.info}`);
                error.retryable = data.error.code === 'maxlag' || data.error.code === 'ratelimited';
                throw error;
            }
            if (data.warnings) {
                debugLog.warning(`Aviso da API (${label}): ${JSON.stringify(data.warnings)}`);
            }
            throttle.onSuccess();
            return data;
        } catch (error) {
            const message = error.name === 'AbortError'
                ? `timeout após ${REQUEST_TIMEOUT / 1000}s`
                : error.message;

            if (attempt < MAX_RETRIES && error.retryable !== false) {
                if (!error.rateLimited) {
                    debugLog.warning(`${label}: ${message} — tentativa ${attempt}/${MAX_RETRIES}, tentando de novo`);
                    await sleep(800 * attempt);
                }
                continue;
            }
            throw new Error(`${label}: ${message}`);
        } finally {
            clearTimeout(timer);
        }
    }
}

class Autocomplete {
    constructor(inputElement, suggestionsElement) {
        this.input = inputElement;
        this.suggestionsElement = suggestionsElement;
        this.suggestions = [];
        this.selectedIndex = -1;
        this.searchTimeout = null;
        this.searchCache = new Map();

        this.input.addEventListener('input', () => this.onInput());
        this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
        document.addEventListener('click', (e) => this.onDocumentClick(e));
    }

    async searchArticles(query) {
        if (this.searchCache.has(query)) {
            this.renderSuggestions(this.searchCache.get(query));
            return;
        }

        this.showLoading();

        try {
            const data = await apiGet({
                action: 'opensearch',
                search: query,
                namespace: '0',
                limit: String(MAX_SUGGESTIONS)
            }, `sugestões para "${query}"`);
            const results = data[1] || [];

            this.searchCache.set(query, results);
            if (this.input.value.trim() === query) this.renderSuggestions(results);
        } catch (error) {
            debugLog.error(`Erro ao buscar sugestões: ${error.message}`);
            this.showEmpty();
        }
    }

    renderSuggestions(results) {
        this.suggestions = results;
        this.selectedIndex = -1;
        this.suggestionsElement.innerHTML = '';

        if (results.length === 0) {
            this.showEmpty();
            return;
        }

        results.forEach((article, index) => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.textContent = article;
            div.addEventListener('click', () => this.selectSuggestion(index));
            this.suggestionsElement.appendChild(div);
        });

        this.suggestionsElement.classList.add('show');
    }

    selectSuggestion(index) {
        if (index >= 0 && index < this.suggestions.length) {
            this.input.value = this.suggestions[index];
            this.hide();
        }
    }

    hide() {
        this.suggestionsElement.classList.remove('show');
        this.suggestions = [];
        this.selectedIndex = -1;
    }

    showLoading() {
        this.suggestionsElement.innerHTML = '<div class="suggestion-loading">⏳ Buscando...</div>';
        this.suggestionsElement.classList.add('show');
    }

    showEmpty() {
        this.suggestionsElement.innerHTML = '<div class="suggestion-empty">Nenhum artigo encontrado</div>';
        this.suggestionsElement.classList.add('show');
    }

    onInput() {
        const query = this.input.value.trim();
        clearTimeout(this.searchTimeout);

        if (query.length < 2) {
            this.hide();
            return;
        }

        this.searchTimeout = setTimeout(() => this.searchArticles(query), SEARCH_DELAY);
    }

    onKeyDown(e) {
        if (this.suggestions.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.selectIndex((this.selectedIndex + 1) % this.suggestions.length);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.selectIndex(this.selectedIndex <= 0 ? this.suggestions.length - 1 : this.selectedIndex - 1);
                break;
            case 'Enter':
                if (this.selectedIndex >= 0) {
                    e.preventDefault();
                    this.selectSuggestion(this.selectedIndex);
                } else {
                    this.hide();
                }
                break;
            case 'Escape':
                this.hide();
                break;
        }
    }

    selectIndex(index) {
        this.suggestionsElement.children[this.selectedIndex]?.classList.remove('selected');
        this.selectedIndex = index;
        const item = this.suggestionsElement.children[index];
        if (item) {
            item.classList.add('selected');
            item.scrollIntoView({ block: 'nearest' });
        }
    }

    onDocumentClick(e) {
        if (!this.input.contains(e.target) && !this.suggestionsElement.contains(e.target)) {
            this.suggestionsElement.classList.remove('show');
        }
    }
}

class SearchCancelled extends Error {}

const pathKey = (path) => path.join('\u0001');

class WikiPathfinder {
    constructor() {
        this.linkCache = new Map();
        this.backlinkCache = new Map();
        this.token = 0;
        this.failed = 0;
        this.reset();
    }

    reset() {
        this.token++;
        this.pathHistory = [];
        this.pending = [];
    }

    // Retorna uma promise de vizinhos por título; títulos fora do cache são buscados em lotes de BATCH_SIZE por requisição.
    fetchNeighbors(titles, backward) {
        const cache = backward ? this.backlinkCache : this.linkCache;
        const missing = [...new Set(titles.filter(t => !cache.has(t)))];

        for (let i = 0; i < missing.length; i += BATCH_SIZE) {
            const group = missing.slice(i, i + BATCH_SIZE);
            const batch = this.fetchBatch(group, backward).catch(error => {
                group.forEach(t => cache.delete(t));
                this.failed += group.length;
                debugLog.error(`Falha ao buscar lote de ${group.length} artigos: ${error.message}`);
                return new Map();
            });
            group.forEach(t => cache.set(t, batch.then(map => map.get(t) ?? [])));
        }

        return titles.map(t => cache.get(t));
    }

    fetchBatch(group, backward) {
        return requestPool.execute(async () => {
            const prop = backward ? 'linkshere' : 'links';
            const prefix = backward ? 'lh' : 'pl';
            const params = {
                action: 'query',
                titles: group.join('|'),
                prop,
                [`${prefix}limit`]: 'max',
                [`${prefix}namespace`]: '0'
            };
            if (backward) params.lhprop = 'title';

            const first = group[0];
            const label = `${backward ? 'artigos que apontam para' : 'links de'} "${first}"${group.length > 1 ? ` e mais ${group.length - 1}` : ''}`;
            const neighbors = new Map(group.map(t => [t, []]));
            const aliases = new Map();
            let cont = null;
            let pages = 0;

            do {
                const data = await apiGet({ ...params, ...cont }, label);
                for (const n of data.query?.normalized ?? []) aliases.set(n.to, n.from);
                for (const page of data.query?.pages ?? []) {
                    const key = aliases.get(page.title) ?? page.title;
                    if (!neighbors.has(key)) neighbors.set(key, []);
                    const list = neighbors.get(key);
                    for (const item of page[prop] ?? []) list.push(item.title);
                }
                cont = data.continue ?? null;
                pages++;
            } while (cont && pages < MAX_BATCH_PAGES);

            if (cont) this.truncated++;
            return neighbors;
        });
    }

    normalizeTitle(title) {
        const trimmed = title.trim();
        return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }

    async validateArticle(title) {
        const normalized = this.normalizeTitle(title);
        try {
            const data = await apiGet({ action: 'query', titles: normalized, redirects: '1' }, `validação de "${normalized}"`);
            const page = data.query?.pages?.[0];
            if (!page || page.missing || page.invalid) return null;

            if (data.query.redirects?.length) {
                debugLog.info(`"${normalized}" é um redirecionamento para "${page.title}"`);
            }
            return page.title;
        } catch (error) {
            debugLog.error(`Erro ao validar artigo: ${error.message}`);
            return null;
        }
    }

    *forwardPaths(node, parents) {
        const ps = parents.get(node);
        if (!ps || ps.size === 0) {
            yield [node];
            return;
        }
        for (const p of ps) {
            for (const path of this.forwardPaths(p, parents)) yield [...path, node];
        }
    }

    *backwardPaths(node, parents) {
        const ps = parents.get(node);
        if (!ps || ps.size === 0) {
            yield [node];
            return;
        }
        for (const p of ps) {
            for (const path of this.backwardPaths(p, parents)) yield [node, ...path];
        }
    }

    // meet = índice do artigo onde as buscas se cruzaram; antes dele os links vieram da frente, depois, de trás.
    buildPaths(meetings, fwdParents, bwdParents, exclude, foundBy, limit = 50) {
        const found = new Map();
        for (const m of meetings) {
            for (const head of this.forwardPaths(m, fwdParents)) {
                for (const tail of this.backwardPaths(m, bwdParents)) {
                    const nodes = [...head, ...tail.slice(1)];
                    const key = pathKey(nodes);
                    if (exclude.has(key) || found.has(key)) continue;
                    if (new Set(nodes).size !== nodes.length) continue;
                    found.set(key, { nodes, meet: head.length - 1, foundBy });
                    if (found.size >= limit) break;
                }
                if (found.size >= limit) break;
            }
            if (found.size >= limit) break;
        }
        return [...found.values()].sort((a, b) => a.nodes.length - b.nodes.length);
    }

    async search(start, end, exclude, onProgress) {
        const token = this.token;
        const startedAt = performance.now();
        const requestsBefore = apiStats.requests;
        this.truncated = 0;
        this.failed = 0;
        this.limitHit = false;
        const maxExplored = exclude.size > 0 ? MAX_EXPLORED_MORE : MAX_EXPLORED;

        const fwd = { name: 'frente', backward: false, parents: new Map([[start, new Set()]]), frontier: [start], depth: 0 };
        const bwd = { name: 'trás', backward: true, parents: new Map([[end, new Set()]]), frontier: [end], depth: 0 };
        const recent = [];
        let explored = 0;

        const finish = (paths, reason) => {
            const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
            debugLog.info(`${reason} em ${seconds}s — ${explored} artigos expandidos, ${apiStats.requests - requestsBefore} requisições`);
            if (this.truncated > 0) {
                debugLog.warning(`${this.truncated} lote(s) passaram de ${MAX_BATCH_PAGES * 500} links e foram cortados; alguns caminhos podem ter ficado de fora`);
            }
            if (this.failed > 0) {
                debugLog.warning(`${this.failed} artigo(s) não puderam ser carregados; a busca ficou incompleta`);
            }
            return paths;
        };

        while (fwd.frontier.length && bwd.frontier.length && fwd.depth + bwd.depth < MAX_DEPTH) {
            const side = fwd.frontier.length <= bwd.frontier.length ? fwd : bwd;
            const other = side === fwd ? bwd : fwd;
            const next = new Set();
            const meetings = new Set();

            debugLog.info(`Expandindo nível ${side.depth + 1} pela ${side.name} (${side.frontier.length} artigos na fronteira)`);

            for (let i = 0; i < side.frontier.length; i += CHUNK_SIZE) {
                const chunk = side.frontier.slice(i, i + CHUNK_SIZE);

                const pending = this.fetchNeighbors(chunk, side.backward);

                await Promise.all(chunk.map(async (node, index) => {
                    const neighbors = await pending[index];
                    if (token !== this.token) return;

                    explored++;
                    recent.unshift(node);
                    if (recent.length > RECENT_SIZE) recent.pop();

                    for (const n of neighbors) {
                        if (!side.parents.has(n)) {
                            side.parents.set(n, new Set([node]));
                            next.add(n);
                        } else if (next.has(n)) {
                            side.parents.get(n).add(node);
                        } else {
                            continue;
                        }
                        if (other.parents.has(n)) meetings.add(n);
                    }

                    onProgress?.({
                        side: side.name,
                        depth: fwd.depth + bwd.depth,
                        explored,
                        known: fwd.parents.size + bwd.parents.size,
                        recent: [...recent]
                    });
                }));

                if (token !== this.token) throw new SearchCancelled();

                if (meetings.size > 0) {
                    const paths = this.buildPaths(meetings, fwd.parents, bwd.parents, exclude, side.name);
                    if (paths.length > 0) return finish(paths, `${paths.length} caminho(s) de ${paths[0].nodes.length} artigos encontrados`);
                }

                if (explored >= maxExplored) {
                    this.limitHit = true;
                    debugLog.warning(`Limite de ${maxExplored} artigos expandidos atingido; busca interrompida`);
                    return finish([], 'Busca interrompida');
                }
            }

            side.frontier = [...next];
            side.depth++;
        }

        const reason = fwd.depth + bwd.depth >= MAX_DEPTH
            ? `Limite de profundidade (${MAX_DEPTH}) atingido sem caminho`
            : 'Uma das fronteiras ficou vazia (não há mais links a explorar)';
        return finish([], reason);
    }

    async findNextPath(start, end, onProgress = null) {
        if (this.pending.length === 0) {
            const exclude = new Set(this.pathHistory.map(p => pathKey(p.nodes)));
            this.pending = await this.search(start, end, exclude, onProgress);
        }

        const path = this.pending.shift() ?? null;
        if (path) this.pathHistory.push(path);
        return path;
    }

    getWikipediaUrl(title) {
        return `https://pt.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    }
}

const pathfinder = new WikiPathfinder();

const article1 = document.getElementById('article1');
const article2 = document.getElementById('article2');
const searchBtn = document.getElementById('searchBtn');
const clearBtn = document.getElementById('clearBtn');
const moreBtn = document.getElementById('moreBtn');
const newSearchBtn = document.getElementById('newSearchBtn');
const statusBox = document.getElementById('status');
const statusText = document.getElementById('statusText');
const progressInfo = document.getElementById('progressInfo');
const currentExploration = document.getElementById('currentExploration');
const results = document.getElementById('results');
const pathsContainer = document.getElementById('pathsContainer');
const info = document.getElementById('info');
const debugLogElement = document.getElementById('debugLog');
const debugToggle = document.getElementById('debugToggle');
const copyLogsBtn = document.getElementById('copyLogsBtn');
const searchCounter = document.getElementById('searchCounter');

function readSearchCount() {
    try {
        return Number(localStorage.getItem('menorCaminho.buscas')) || 0;
    } catch {
        return 0;
    }
}

function renderSearchCount(count) {
    searchCounter.textContent = String(count).padStart(6, '0');
}

function bumpSearchCount() {
    const count = readSearchCount() + 1;
    try {
        localStorage.setItem('menorCaminho.buscas', String(count));
    } catch {}
    renderSearchCount(count);
}

renderSearchCount(readSearchCount());

debugLog.attach(debugLogElement);

new Autocomplete(article1, document.getElementById('suggestions1'));
new Autocomplete(article2, document.getElementById('suggestions2'));

let currentStart = '';
let currentEnd = '';
let pendingProgress = null;

function showStatus(message, type = 'loading') {
    statusText.textContent = type === 'loading' ? '⏳ ' + message : message;
    statusBox.className = `status show ${type}`;
    progressInfo.innerHTML = '';
    currentExploration.innerHTML = '';
    if (type === 'error') debugLog.error(message);
}

function hideStatus() {
    statusBox.className = 'status';
    progressInfo.innerHTML = '';
    currentExploration.innerHTML = '';
}

function updateProgress(data) {
    const scheduled = pendingProgress !== null;
    pendingProgress = data;
    if (!scheduled) requestAnimationFrame(renderProgress);
}

function renderProgress() {
    const data = pendingProgress;
    pendingProgress = null;
    if (!data || !statusBox.classList.contains('loading')) return;

    const stat = (label, value) => `
        <div class="progress-stat">
            <span class="progress-stat-label">${label}:</span>
            <span class="progress-stat-value">${value}</span>
        </div>`;

    progressInfo.innerHTML =
        stat('Profundidade', `${data.depth}/${MAX_DEPTH}`) +
        stat('Expandidos', data.explored.toLocaleString('pt-BR')) +
        stat('Conhecidos', data.known.toLocaleString('pt-BR')) +
        stat('Direção', data.side === 'frente' ? '→ frente' : '← trás');

    const items = data.recent
        .map(article => `<span class="exploration-item" title="${escapeHtml(article)}">${escapeHtml(article)}</span>`)
        .join('');
    currentExploration.innerHTML = `
        <div class="exploration-title">📍 Explorando agora:</div>
        <div class="exploration-items">${items}</div>`;
}

function describeMeeting(path) {
    const { nodes, meet, foundBy } = path;
    return `Encontro em "${nodes[meet]}": ${meet} clique(s) pela frente, ${nodes.length - 1 - meet} por trás (cruzamento detectado ao expandir pela ${foundBy})`;
}

function renderPath(path, pathNumber) {
    const { nodes, meet, foundBy } = path;
    const pathItem = document.createElement('div');
    pathItem.className = 'path-item';

    const title = document.createElement('div');
    title.className = 'path-title';

    const number = document.createElement('span');
    number.className = 'path-number';
    number.textContent = pathNumber;

    const lengthSpan = document.createElement('span');
    lengthSpan.className = 'path-length';
    lengthSpan.textContent = `${nodes.length} artigos · ${nodes.length - 1} cliques`;

    title.append(number, ` Caminho ${pathNumber}`, lengthSpan);

    const pathItems = document.createElement('div');
    pathItems.className = 'path-items';

    nodes.forEach((article, index) => {
        const side = index === meet ? 'meet' : index < meet ? 'side-front' : 'side-back';
        const link = document.createElement('a');
        link.className = `article-link ${side}`;
        link.href = pathfinder.getWikipediaUrl(article);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = index === meet ? `✦ ${article}` : article;
        if (index === meet) {
            link.title = `Ponto de encontro: as duas buscas se cruzaram aqui (detectado ao expandir pela ${foundBy})`;
        }
        pathItems.appendChild(link);

        if (index < nodes.length - 1) {
            const fromFront = index < meet;
            const arrow = document.createElement('span');
            arrow.className = `arrow ${fromFront ? 'arrow-front' : 'arrow-back'}`;
            arrow.textContent = fromFront ? '→' : '←';
            arrow.title = fromFront
                ? `Busca a partir da origem. "${article}" tem link para "${nodes[index + 1]}"`
                : `Busca a partir do destino. "${article}" tem link para "${nodes[index + 1]}"`;
            pathItems.appendChild(arrow);
        }
    });

    const legend = document.createElement('div');
    legend.className = 'path-legend';
    legend.innerHTML = `
        <span class="legend-item"><span class="legend-dot side-front"></span>busca a partir da origem</span>
        <span class="legend-item"><span class="legend-dot meet"></span>ponto de encontro</span>
        <span class="legend-item"><span class="legend-dot side-back"></span>busca a partir do destino</span>`;
    const meetingNote = document.createElement('div');
    meetingNote.className = 'path-meeting';
    meetingNote.textContent = describeMeeting(path);

    pathItem.append(title, pathItems, legend, meetingNote);
    return pathItem;
}

function displayResults() {
    results.classList.add('show');
    pathsContainer.innerHTML = '';

    pathfinder.pathHistory.forEach((path, index) => {
        pathsContainer.appendChild(renderPath(path, index + 1));
    });

    moreBtn.style.display = pathfinder.pathHistory.length < MAX_PATHS ? 'inline-block' : 'none';
    moreBtn.disabled = false;

    info.textContent = `Mostrando ${pathfinder.pathHistory.length} caminho(s) encontrado(s)`;
}

async function findPath() {
    const start = article1.value.trim();
    const end = article2.value.trim();

    if (!start || !end) {
        showStatus('Por favor, preencha ambos os artigos', 'error');
        return;
    }

    pathfinder.reset();
    results.classList.remove('show');
    info.textContent = '';
    showStatus('Validando artigos...');
    searchBtn.disabled = true;

    try {
        const [validatedStart, validatedEnd] = await Promise.all([
            pathfinder.validateArticle(start),
            pathfinder.validateArticle(end)
        ]);

        if (!validatedStart) {
            showStatus(`Artigo "${start}" não encontrado na Wikipédia em português`, 'error');
            return;
        }
        if (!validatedEnd) {
            showStatus(`Artigo "${end}" não encontrado na Wikipédia em português`, 'error');
            return;
        }
        if (validatedStart === validatedEnd) {
            showStatus('Os artigos de origem e destino devem ser diferentes', 'error');
            return;
        }

        currentStart = validatedStart;
        currentEnd = validatedEnd;
        article1.value = validatedStart;
        article2.value = validatedEnd;

        bumpSearchCount();
        debugLog.info(`Iniciando busca: ${validatedStart} → ${validatedEnd}`);
        showStatus('Buscando caminho mais curto...');

        const path = await pathfinder.findNextPath(currentStart, currentEnd, updateProgress);

        if (path) {
            debugLog.success(`Caminho 1: ${path.nodes.join(' → ')}`);
            debugLog.info(describeMeeting(path));
            hideStatus();
            displayResults();
        } else if (pathfinder.failed > 0) {
            showStatus(`Busca incompleta: ${pathfinder.failed} artigo(s) não puderam ser carregados da Wikipédia. Veja o log e tente de novo.`, 'error');
        } else if (pathfinder.limitHit) {
            showStatus(`Busca interrompida: mais de ${MAX_EXPLORED.toLocaleString('pt-BR')} artigos explorados sem encontrar um caminho`, 'error');
        } else {
            showStatus(`Nenhum caminho encontrado entre "${currentStart}" e "${currentEnd}" (limite de profundidade: ${MAX_DEPTH})`, 'error');
        }
    } catch (error) {
        if (error instanceof SearchCancelled) {
            debugLog.info('Busca cancelada');
            return;
        }
        debugLog.error(`Erro inesperado na busca: ${error.stack || error.message}`);
        showStatus('Erro ao processar a busca: ' + error.message, 'error');
    } finally {
        searchBtn.disabled = false;
    }
}

async function findMorePaths() {
    if (pathfinder.pathHistory.length >= MAX_PATHS) {
        showStatus('Limite de caminhos alcançado', 'error');
        return;
    }

    moreBtn.disabled = true;
    const number = pathfinder.pathHistory.length + 1;
    showStatus(`Buscando caminho ${number}...`);

    try {
        const path = await pathfinder.findNextPath(currentStart, currentEnd, updateProgress);

        if (path) {
            debugLog.success(`Caminho ${number}: ${path.nodes.join(' → ')}`);
            debugLog.info(describeMeeting(path));
            hideStatus();
            displayResults();
        } else if (pathfinder.failed > 0) {
            showStatus(`Busca incompleta: ${pathfinder.failed} artigo(s) não puderam ser carregados. Tente "Próximos Caminhos" de novo.`, 'error');
            moreBtn.disabled = false;
        } else if (pathfinder.limitHit) {
            showStatus(`Nenhum outro caminho encontrado nos primeiros ${MAX_EXPLORED_MORE.toLocaleString('pt-BR')} artigos explorados`, 'error');
            moreBtn.style.display = 'none';
        } else {
            showStatus('Nenhum caminho adicional encontrado', 'error');
            moreBtn.style.display = 'none';
        }
    } catch (error) {
        if (error instanceof SearchCancelled) {
            debugLog.info('Busca cancelada');
            return;
        }
        debugLog.error(`Erro inesperado ao buscar próximo caminho: ${error.stack || error.message}`);
        showStatus('Erro ao buscar próximo caminho: ' + error.message, 'error');
        moreBtn.disabled = false;
    }
}

function clearSearch() {
    article1.value = '';
    article2.value = '';
    pathfinder.reset();
    results.classList.remove('show');
    hideStatus();
    info.textContent = '';
    currentStart = '';
    currentEnd = '';
    searchBtn.disabled = false;
    article1.focus();
}

async function copyLogs() {
    const text = [
        `Menor Caminho na Wikipédia — log (${new Date().toLocaleString('pt-BR')})`,
        `Navegador: ${navigator.userAgent}`,
        '',
        debugLog.toText()
    ].join('\n');

    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        if (!ok) {
            debugLog.error('Não foi possível copiar o log para a área de transferência');
            return;
        }
    }

    copyLogsBtn.textContent = 'Copiado!';
    setTimeout(() => { copyLogsBtn.textContent = 'Copiar Log'; }, 1500);
}

searchBtn.addEventListener('click', findPath);
clearBtn.addEventListener('click', clearSearch);
moreBtn.addEventListener('click', findMorePaths);
newSearchBtn.addEventListener('click', clearSearch);
copyLogsBtn.addEventListener('click', copyLogs);

article1.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') findPath();
});
article2.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') findPath();
});

debugToggle.addEventListener('click', () => {
    const visible = debugLogElement.classList.toggle('show');
    debugToggle.textContent = visible ? '📋 Ocultar Logs' : '📋 Mostrar Logs';
    if (visible) debugLogElement.scrollTop = debugLogElement.scrollHeight;
});

article1.focus();
debugLog.info('Aplicação iniciada');
