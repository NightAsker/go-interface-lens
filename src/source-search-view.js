'use strict';

/**
 * A native-looking source search view for the activity bar.
 *
 * The provider deliberately knows nothing about how sources are found.  An
 * engine can be supplied with setEngine() (or in the constructor) and only
 * needs to expose search(options, { onBatch, signal }).  Batches may be an
 * array of match objects or an object containing `results`/`matches`.
 */
const vscode = require('vscode');

const VIEW_TYPE = 'go-interface-lens.sourceSearch';

function randomNonce() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function isPromise(value) {
    return value && typeof value.then === 'function';
}

class SourceSearchViewProvider {
    static viewType = VIEW_TYPE;

    /**
     * @param {{engine?: object, searchService?: object, onOpenMatch?: function,
     *   onOpenInEditor?: function, onSearch?: function, logger?: function}} [options]
     */
    constructor(options = {}) {
        this.engine = options.engine || options.searchService || null;
        this.onOpenMatch = options.onOpenMatch;
        this.onOpenInEditor = options.onOpenInEditor;
        this.onSearch = options.onSearch;
        this.logger = typeof options.logger === 'function' ? options.logger : () => {};
        this._view = null;
        this._disposables = [];
        this._searchAbort = null;
        this._searchId = 0;
    }

    setEngine(engine) {
        this.engine = engine;
        return this;
    }

    setHandlers({ onOpenMatch, onOpenInEditor, onSearch } = {}) {
        if (typeof onOpenMatch === 'function') this.onOpenMatch = onOpenMatch;
        if (typeof onOpenInEditor === 'function') this.onOpenInEditor = onOpenInEditor;
        if (typeof onSearch === 'function') this.onSearch = onSearch;
        return this;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, retainContextWhenHidden: true };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        if (typeof webviewView.webview.onDidReceiveMessage === 'function') {
            const receiver = webviewView.webview.onDidReceiveMessage((message) => {
                this._handleMessage(message).catch((error) => {
                    this.logger(`source search view: ${error && error.stack ? error.stack : error}`);
                    this._post({ type: 'searchError', message: error.message || String(error) });
                });
            });
            if (receiver && typeof receiver.dispose === 'function') this._disposables.push(receiver);
        }

        if (typeof webviewView.onDidChangeVisibility === 'function') {
            const visibility = webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) this._post({ type: 'viewVisible' });
            });
            if (visibility && typeof visibility.dispose === 'function') this._disposables.push(visibility);
        }

        if (typeof webviewView.onDidDispose === 'function') {
            const dispose = webviewView.onDidDispose(() => this.dispose());
            if (dispose && typeof dispose.dispose === 'function') this._disposables.push(dispose);
        }
    }

    async _handleMessage(message) {
        if (!message || typeof message.type !== 'string') return;
        switch (message.type) {
            case 'ready':
                this._post({ type: 'viewVisible' });
                return;
            case 'search':
                await this._startSearch(message.options || {});
                return;
            case 'cancel':
                this._cancelSearch();
                return;
            case 'clearResults':
                this._cancelSearch();
                this._post({ type: 'clearResults' });
                return;
            case 'openMatch':
                await this._openMatch(message.match || message);
                return;
            case 'openInEditor':
                await this._openInEditor(message);
                return;
            case 'changeScope':
                if (typeof this.onSearch === 'function') await this.onSearch(message);
                return;
            default:
                return;
        }
    }

    async _startSearch(options) {
        this._cancelSearch();
        const searchId = ++this._searchId;
        const controller = new AbortController();
        this._searchAbort = controller;
        const normalized = {
            query: String(options.query || '').trim(),
            scope: options.scope || 'all',
            useRegex: !!(options.useRegex || options.regex),
            regex: !!(options.useRegex || options.regex),
            matchCase: !!options.matchCase,
            caseSensitive: !!(options.matchCase || options.caseSensitive),
            wholeWord: !!options.wholeWord,
            includePattern: options.includePattern || options.include || '',
            includeGlobs: Array.isArray(options.includeGlobs)
                ? options.includeGlobs
                : (options.includePattern || options.include
                    ? String(options.includePattern || options.include).split(',').map((value) => value.trim()).filter(Boolean)
                    : undefined),
            maxResults: Number.isInteger(options.maxResults) ? options.maxResults : undefined,
        };

        this._post({ type: 'searchStarted', options: normalized });
        if (!normalized.query) {
            this._post({ type: 'searchFinished', resultCount: 0, fileCount: 0 });
            return;
        }

        try {
            if (typeof this.onSearch === 'function') {
                await this.onSearch(normalized);
            }

            if (!this.engine || typeof this.engine.search !== 'function') {
                this._post({ type: 'searchFinished', resultCount: 0, fileCount: 0 });
                return;
            }

            let result;
            let receivedBatch = false;
            const callback = (batch) => {
                if (searchId !== this._searchId || controller.signal.aborted) return;
                receivedBatch = true;
                this._post({ type: 'appendResults', results: normalizeBatch(batch) });
            };
            const progress = (info) => {
                if (searchId !== this._searchId || controller.signal.aborted) return;
                this._post({ type: 'searchProgress', ...(info || {}) });
            };

            // SourceSearchService uses search(options, { onBatch, signal }). Keep
            // the fallback for simple engines returning a complete result array.
            result = this.engine.search(normalized, {
                onBatch: callback,
                onProgress: progress,
                signal: controller.signal,
            });
            if (isPromise(result)) result = await result;
            if (searchId !== this._searchId || controller.signal.aborted) return;
            if (!receivedBatch && result !== undefined && result !== null) {
                const batch = normalizeBatch(result);
                if (batch.length > 0) this._post({ type: 'appendResults', results: batch });
            }
            this._post({
                type: 'searchFinished',
                resultCount: result && Number.isFinite(result.totalMatches) ? result.totalMatches : undefined,
                fileCount: result && Number.isFinite(result.totalFiles) ? result.totalFiles : undefined,
                truncated: !!(result && result.truncated),
            });
        } catch (error) {
            if (searchId !== this._searchId || controller.signal.aborted || isAbortError(error)) {
                this._post({ type: 'searchFinished', cancelled: true });
                return;
            }
            this.logger(`source search failed: ${error && error.stack ? error.stack : error}`);
            this._post({ type: 'searchError', message: error && error.message ? error.message : String(error) });
        } finally {
            if (this._searchAbort === controller) this._searchAbort = null;
        }
    }

    _cancelSearch() {
        if (this._searchAbort) {
            try {
                this._searchAbort.abort();
            } catch (_) {}
            this._searchAbort = null;
            this._post({ type: 'searchFinished', cancelled: true });
        }
        this._searchId++;
    }

    async _openMatch(match) {
        if (typeof this.onOpenMatch === 'function') {
            await this.onOpenMatch(match);
            return;
        }
        if (!match || !match.file) return;
        const document = await vscode.workspace.openTextDocument(match.file);
        const line = Math.max(0, Number(match.line || 1) - 1);
        const column = Math.max(0, Number(match.column || 1) - 1);
        const position = new vscode.Position(line, column);
        await vscode.window.showTextDocument(document, { selection: new vscode.Selection(position, position) });
    }

    async _openInEditor(message) {
        if (typeof this.onOpenInEditor === 'function') {
            await this.onOpenInEditor(message);
            return;
        }
        // The extension may provide an editor result view later. Silently
        // ignore this action when no host handler has been wired yet.
    }

    _post(message) {
        if (!this._view || !this._view.webview || typeof this._view.webview.postMessage !== 'function') return;
        try {
            this._view.webview.postMessage(message);
        } catch (error) {
            this.logger(`source search view message failed: ${error.message || error}`);
        }
    }

    _getHtml(webview) {
        const nonce = randomNonce();
        const cspSource = webview && webview.cspSource ? webview.cspSource : 'https:';
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Go Source Search</title>
  <style>
    :root {
      color-scheme: light dark;
      --muted: var(--vscode-descriptionForeground, #8b949e);
      --border: var(--vscode-panel-border, rgba(127, 127, 127, .24));
      --input-bg: var(--vscode-input-background, rgba(127,127,127,.12));
      --input-border: var(--vscode-input-border, transparent);
      --hover: var(--vscode-list-hoverBackground, rgba(127,127,127,.12));
      --active: var(--vscode-list-activeSelectionBackground, rgba(38,79,120,.55));
      --active-fg: var(--vscode-list-activeSelectionForeground, #fff);
      --accent: var(--vscode-textLink-foreground, #4daafc);
      --badge: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #fff);
      --code: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
    }
    * { box-sizing: border-box; }
    html, body { padding: 0; margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.45;
    }
    button, input, select { font: inherit; color: inherit; }
    button { border: 0; background: transparent; cursor: pointer; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
    .shell { display: flex; flex-direction: column; height: 100%; min-width: 0; }
    /* These offsets mirror VS Code's SearchView: the replace toggle is 16px
       wide and the input starts 18px after the widget edge. */
    .header { margin: 0 12px 0 2px; padding: 6px 0; }
    .search-row { position: relative; display: flex; align-items: stretch; min-height: 26px; }
    .search-toggle { position: absolute; left: 0; top: 0; width: 16px; height: 26px; padding: 0; color: var(--muted); display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; z-index: 1; }
    .search-toggle:hover { background: var(--hover); color: var(--vscode-foreground); }
    .search-toggle svg { width: 16px; height: 16px; }
    .search-box { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0; height: 26px; margin-left: 18px; padding: 0 2px 0 0; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 3px; }
    .search-box:focus-within { border-color: var(--vscode-focusBorder, #007fd4); }
    #query { flex: 1 1 auto; width: auto; min-width: 0; height: 24px; padding: 3px 0 3px 6px; background: transparent; border: 0; outline: 0; }
    #query::placeholder { color: var(--muted); }
    .search-filter-controls { position: relative; z-index: 2; display: inline-flex; align-items: center; gap: 1px; flex: 0 0 auto; pointer-events: auto; }
    .search-filter-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 25px; height: 22px; padding: 0 3px; border-radius: 3px; color: var(--vscode-icon-foreground, var(--muted)); font-size: 13px; line-height: 1; user-select: none; }
    .search-filter-btn:hover { background: var(--hover); color: var(--vscode-foreground); }
    .search-filter-btn.active { color: var(--vscode-inputOption-activeForeground, var(--accent)); background: var(--vscode-inputOption-activeBackground, var(--vscode-toolbar-hoverBackground, rgba(80, 150, 220, .13))); outline: 1px solid var(--vscode-inputOption-activeBorder, var(--accent)); outline-offset: -1px; }
    .search-filter-btn.word { text-decoration: underline; text-underline-offset: 2px; }
    .search-filter-btn svg { width: 16px; height: 16px; }
    .query-details { min-height: 16px; position: relative; margin: 0 0 0 18px; }
    .details-toggle { position: absolute; right: -2px; top: 0; width: 25px; height: 16px; padding: 0; color: var(--muted); font-size: 16px; line-height: 12px; border-radius: 3px; }
    .details-toggle:hover { background: var(--hover); color: var(--vscode-foreground); }
    .scope-row { display: none; align-items: center; gap: 6px; padding: 4px 0; }
    .query-details.expanded .scope-row { display: flex; }
    .scope-row[hidden] { display: none !important; }
    .scope { flex: 1; min-width: 0; height: 24px; padding: 0 5px; border: 1px solid var(--input-border); border-radius: 3px; background: var(--input-bg); font-size: 12px; }
    .summary { display: block; min-height: 22px; margin-top: -5px; padding: 0 22px 8px; color: var(--vscode-search-resultsInfoForeground, var(--muted)); font-size: 13px; line-height: 22px; }
    .summary strong { color: var(--vscode-foreground); font-weight: 500; }
    .summary a { color: var(--accent); text-decoration: none; cursor: pointer; white-space: nowrap; margin-left: 4px; }
    .summary a::before { content: "- "; color: var(--vscode-search-resultsInfoForeground, var(--muted)); }
    .summary a:hover { text-decoration: underline; }
    #status { white-space: normal; }
    .progress { height: 2px; margin: 0 12px; overflow: hidden; background: transparent; }
    .progress.busy::after { content: ""; display: block; height: 100%; width: 38%; background: var(--accent); animation: slide 1.05s ease-in-out infinite; }
    @keyframes slide { 0% { transform: translateX(-120%); } 55%, 100% { transform: translateX(290%); } }
    .results { flex: 1; min-height: 0; overflow: auto; padding: 0 0 18px; }
    .empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 7px; padding: 34px 18px; color: var(--muted); }
    .empty[hidden] { display: none !important; }
    .empty svg { width: 28px; height: 28px; opacity: .75; }
    .empty-title { color: var(--vscode-foreground); font-weight: 500; }
    .empty-hint { font-size: 12px; max-width: 240px; }
    .file { border-radius: 0; margin: 0; overflow: hidden; }
    .file-head { display: flex; align-items: center; min-width: 0; gap: 0; height: 22px; min-height: 22px; line-height: 22px; padding: 0; border-radius: 0; cursor: pointer; }
    .file-head:hover { background: var(--hover); }
    .twisty { width: 16px; height: 22px; flex: 0 0 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); transition: transform .12s ease; transform: translateX(3px); }
    .twisty svg { width: 12px; height: 12px; }
    .file.collapsed .twisty { transform: translateX(3px) rotate(-90deg); }
    .file-icon { display: inline-flex; width: 19px; height: 22px; align-items: center; color: #00add8; flex: 0 0 19px; }
    .file-icon svg { width: 16px; height: 16px; }
    .file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-sideBar-foreground, var(--vscode-foreground)); font-size: 13px; }
    .file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 13px; margin-left: 6px; }
    .count { flex: 0 0 auto; min-width: 18px; min-height: 18px; height: 18px; padding: 3px 5px; margin-left: auto; margin-right: 12px; display: inline-flex; justify-content: center; align-items: center; border-radius: 11px; color: var(--badge-fg); background: var(--badge); font-size: 11px; line-height: 11px; font-weight: 400; }
    .matches { margin-left: 22px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke, var(--border)); padding: 0 0 0 6px; }
    .file.collapsed .matches { display: none; }
    .match { display: flex; gap: 0; min-width: 0; padding: 0; border-radius: 0; cursor: pointer; color: var(--vscode-foreground); line-height: 22px; }
    .match:hover { background: var(--hover); color: var(--vscode-foreground); }
    .line-number { flex: 0 0 auto; margin-left: 7px; margin-right: 4px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; user-select: none; opacity: .82; }
    .match-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; color: var(--code); font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace)); font-size: 11px; }
    mark { color: var(--vscode-editor-findMatchHighlightForeground, var(--vscode-foreground)); background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 198, 67, .3)); border: 1px solid var(--vscode-editor-findMatchHighlightBorder, transparent); border-radius: 0; padding: 0 1px; }
    .result-ellipsis { padding: 3px 6px; color: var(--muted); font-size: 11px; }
  </style>
</head>
<body>
  <div class="shell">
    <header class="header">
      <div class="search-row">
        <button class="search-toggle" id="search-toggle" type="button" title="Search options" aria-label="Search options" aria-expanded="false">${iconChevronSvg()}</button>
        <div class="search-box" role="search">
          <input id="query" type="search" aria-label="Search source" autocomplete="off" spellcheck="false" placeholder="Search workspace and dependencies" />
          <span class="search-filter-controls" aria-label="Search filters">
            <button class="search-filter-btn" id="case" title="Match case" aria-label="Match case" aria-pressed="false">Aa</button>
            <button class="search-filter-btn word" id="word" title="Match whole word" aria-label="Match whole word" aria-pressed="false">ab</button>
            <button class="search-filter-btn" id="regex" title="Use regular expression" aria-label="Use regular expression" aria-pressed="false">${iconRegexSvg()}</button>
          </span>
        </div>
      </div>
      <div class="query-details" id="query-details">
        <button class="details-toggle" id="details-toggle" type="button" title="Search options" aria-label="Search options" aria-expanded="false">…</button>
        <div class="scope-row" id="scope-row" hidden>
          <select class="scope" id="scope" aria-label="Search scope">
            <option value="all">All sources</option>
            <option value="workspace">Workspace</option>
            <option value="dependency">Dependencies</option>
            <option value="stdlib">Standard library</option>
          </select>
        </div>
      </div>
    </header>
    <div class="summary"><span id="status">Type to search source</span><a id="open-editor" hidden>Open in editor</a></div>
    <div class="progress" id="progress"></div>
    <main class="results" id="results" role="tree" aria-label="Search results">
      <div class="empty" id="empty">${iconCompassSvg()}<div class="empty-title">Search Go source</div><div class="empty-hint">Search your workspace, module cache, and standard library.</div></div>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const query = document.getElementById('query');
    const scope = document.getElementById('scope');
    const searchToggle = document.getElementById('search-toggle');
    const queryDetails = document.getElementById('query-details');
    const detailsToggle = document.getElementById('details-toggle');
    const scopeRow = document.getElementById('scope-row');
    const results = document.getElementById('results');
    const status = document.getElementById('status');
    const progress = document.getElementById('progress');
    const openEditor = document.getElementById('open-editor');
    const empty = document.getElementById('empty');
    const filters = { regex: false, matchCase: false, wholeWord: false };
    const files = new Map();
    let running = false;
    let latestOptions = {};
    let resultCount = 0;
    let fileCount = 0;
    let lastBatch = [];
    let truncated = false;

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
    }
    function icon(name) {
      const paths = { down: '<path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>', file: '<path d="M4 1.75h5l3 3V14H4z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.75v3h3" fill="none" stroke="currentColor" stroke-width="1.2"/>', go: '<path d="M4.21172 6.52992C4.21172 6.52992 4.25172 6.54992 4.23172 6.57992L4.10172 6.77992C4.10172 6.77992 4.05172 6.82992 4.02172 6.82992H1.21172C1.21172 6.82992 1.17172 6.80992 1.19172 6.77992L1.35172 6.56992C1.35172 6.56992 1.40172 6.52992 1.44172 6.52992H4.22172H4.21172ZM0.261719 7.24992C0.261719 7.24992 0.191719 7.26992 0.171719 7.28992L0.0117188 7.49992C0.0117188 7.49992 0.0117188 7.53992 0.0317187 7.53992H3.71172C3.71172 7.53992 3.77172 7.51992 3.78172 7.48992L3.84172 7.29992C3.84172 7.29992 3.84172 7.24992 3.80172 7.24992H0.261719ZM2.08172 7.96992C2.08172 7.96992 2.02172 7.98992 2.00172 8.01992L1.89172 8.20992C1.89172 8.20992 1.89172 8.25992 1.91172 8.25992H3.61172C3.61172 8.25992 3.66172 8.23992 3.66172 8.20992L3.68172 8.01992C3.68172 8.01992 3.66172 7.96992 3.63172 7.96992H2.07172H2.08172ZM15.0717 9.91992C14.5617 10.4399 13.9217 10.7699 13.2017 10.9199C12.9917 10.9599 12.7817 10.9699 12.5817 10.98992C11.8717 10.96992 11.2217 10.76992 10.6817 10.29992C10.2917 9.95992 10.0317 9.53992 9.90172 9.04992C9.81172 9.24992 9.71172 9.43992 9.57172 9.61992C9.01172 10.3599 8.28172 10.8199 7.35172 10.9399C6.59172 11.0399 5.88172 10.8899 5.25172 10.4299C4.67172 9.98992 4.35172 9.41992 4.26172 8.69992C4.16172 7.84992 4.41172 7.08992 4.92172 6.41992C5.47172 5.69992 6.21172 5.23992 7.10172 5.06992C7.83172 4.93992 8.53172 5.01992 9.16172 5.44992C9.57172 5.71992 9.87172 6.09992 10.0617 6.54992C10.1117 6.61992 10.0817 6.65992 9.98172 6.67992C9.49172 6.79992 9.15172 6.89992 8.67172 7.01992C8.55172 7.04992 8.55172 7.05992 8.44172 6.93992C8.32172 6.80992 8.24172 6.71992 8.07172 6.63992C7.58172 6.39992 7.10172 6.46992 6.66172 6.75992C6.13172 7.09992 5.86172 7.60992 5.87172 8.23992C5.87172 8.85992 6.31172 9.37992 6.92172 9.45992C7.45172 9.52992 7.89172 9.33992 8.24172 8.94992C8.31172 8.85992 8.37172 8.76992 8.45172 8.65992H6.95172C6.79172 8.65992 6.75172 8.55992 6.80172 8.42992C6.90172 8.18992 7.09172 7.77992 7.20172 7.57992C7.22172 7.52992 7.28172 7.45992 7.39172 7.45992H9.91172C10.02172 7.09992 10.20172 6.76992 10.44172 6.44992C11.01172 5.69992 11.69172 5.30992 12.62172 5.14992C13.41172 5.00992 14.16172 5.08992 14.84172 5.54992C15.46172 5.96992 15.84172 6.53992 15.94172 7.28992C16.07172 8.33992 15.77172 9.19992 15.04172 9.92992L15.0717 9.91992ZM14.44172 7.83992C14.44172 7.73992 14.44172 7.65992 14.42172 7.57992C14.28172 6.80992 13.57172 6.36992 12.83172 6.53992C12.11172 6.69992 11.64172 7.15992 11.47172 7.89992C11.33172 8.50992 11.63172 9.11992 12.19172 9.36992C12.62172 9.55992 13.05172 9.52992 13.46172 9.31992C14.08172 8.99992 14.41172 8.49992 14.45172 7.82992L14.44172 7.83992Z" fill="currentColor"' };
      if (name === 'go') return '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths.go + '/></svg>';
      return '<svg viewBox="0 0 14 14" aria-hidden="true">' + (paths[name] || paths.file) + '</svg>';
    }
    function highlight(text) {
      const value = String(text == null ? '' : text);
      const q = String(latestOptions.query || '');
      if (!q) return esc(value);
      let source = q;
      if (!latestOptions.useRegex) {
        let escaped = '';
        for (const character of source) {
          if ('^$.*+?()[]{}|'.includes(character) || character.charCodeAt(0) === 92) escaped += '\\\\' + character;
          else escaped += character;
        }
        source = escaped;
      }
      if (latestOptions.wholeWord) source = '\\\\b' + source + '\\\\b';
      let re;
      try { re = new RegExp(source, latestOptions.matchCase ? 'g' : 'gi'); } catch (_) { return esc(value); }
      let output = '', last = 0, match;
      while ((match = re.exec(value))) {
        output += esc(value.slice(last, match.index)) + '<mark>' + esc(match[0]) + '</mark>';
        last = match.index + match[0].length;
        if (!match[0].length) re.lastIndex++;
      }
      return output + esc(value.slice(last));
    }
    function sendSearch() {
      const value = query.value.trim();
      latestOptions = { query: value, scope: scope.value, useRegex: filters.regex, regex: filters.regex, matchCase: filters.matchCase, caseSensitive: filters.matchCase, wholeWord: filters.wholeWord };
      vscode.postMessage({ type: 'search', options: latestOptions });
    }
    function setFilter(id, key) {
      filters[key] = !filters[key];
      const button = document.getElementById(id);
      button.classList.toggle('active', filters[key]);
      button.setAttribute('aria-pressed', String(filters[key]));
      if (query.value.trim()) sendSearch();
    }
    function syncFilterButtons(options) {
      filters.regex = !!(options && (options.useRegex || options.regex));
      filters.matchCase = !!(options && (options.matchCase || options.caseSensitive));
      filters.wholeWord = !!(options && options.wholeWord);
      [['regex', 'regex'], ['case', 'matchCase'], ['word', 'wholeWord']].forEach(([id, key]) => {
        const button = document.getElementById(id);
        button.classList.toggle('active', filters[key]);
        button.setAttribute('aria-pressed', String(filters[key]));
      });
    }
    function toggleDetails() {
      const expanded = !queryDetails.classList.contains('expanded');
      queryDetails.classList.toggle('expanded', expanded);
      scopeRow.hidden = !expanded;
      detailsToggle.setAttribute('aria-expanded', String(expanded));
      searchToggle.setAttribute('aria-expanded', String(expanded));
    }
    searchToggle.addEventListener('click', toggleDetails);
    detailsToggle.addEventListener('click', toggleDetails);
    query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendSearch();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (running) vscode.postMessage({ type: 'cancel' });
        else { query.value = ''; vscode.postMessage({ type: 'clearResults' }); }
      }
    });
    scope.addEventListener('change', () => { if (query.value.trim()) sendSearch(); });
    document.getElementById('regex').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); setFilter('regex', 'regex'); });
    document.getElementById('case').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); setFilter('case', 'matchCase'); });
    document.getElementById('word').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); setFilter('word', 'wholeWord'); });
    openEditor.addEventListener('click', () => vscode.postMessage({ type: 'openInEditor', options: latestOptions, results: lastBatch }));

    function reset() {
      files.clear(); resultCount = 0; fileCount = 0; lastBatch = []; truncated = false;
      results.innerHTML = ''; results.appendChild(empty); empty.hidden = false; openEditor.hidden = true;
    }
    function normaliseMatch(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const file = raw.file || raw.path || raw.filePath || (raw.uri && raw.uri.fsPath);
      if (!file) return null;
      const line = Number(raw.line || raw.lineNumber || 1);
      const column = Number(raw.column || raw.columnNumber || 1);
      const text = raw.text == null ? (raw.preview == null ? '' : raw.preview) : raw.text;
      // ripgrep returns the complete source line. Native Search renders the
      // matching line as a compact preview and removes its indentation.
      const preview = String(text).trimStart();
      return { file: String(file), relativePath: raw.relativePath || '', line: Number.isFinite(line) ? line : 1, column: Number.isFinite(column) ? column : 1, text: String(text), preview, scope: raw.scope || '', scopeLabel: raw.scopeLabel || '', rootLabel: raw.rootLabel || '', module: raw.module || '', version: raw.version || '', unsaved: !!raw.unsaved, ranges: raw.ranges || [] };
    }
    function addMatches(batch) {
      if (!Array.isArray(batch)) batch = [batch];
      const flat = [];
      batch.forEach((entry) => {
        if (!entry) return;
        if (entry.matches && Array.isArray(entry.matches)) {
          entry.matches.forEach((item) => flat.push({ ...item, file: item.file || item.path || entry.file, relativePath: item.relativePath || entry.relativePath, scope: item.scope || entry.scope, scopeLabel: item.scopeLabel || entry.scopeLabel, rootLabel: item.rootLabel || entry.rootLabel, module: item.module || entry.module, version: item.version || entry.version }));
        } else flat.push(entry);
      });
      flat.map(normaliseMatch).filter(Boolean).forEach((match) => {
        let file = files.get(match.file);
        if (!file) { file = { file: match.file, relativePath: match.relativePath, scope: match.scope, scopeLabel: match.scopeLabel, rootLabel: match.rootLabel, module: match.module, version: match.version, unsaved: match.unsaved, matches: [], collapsed: false }; files.set(match.file, file); }
        file.relativePath = file.relativePath || match.relativePath; file.scope = file.scope || match.scope; file.scopeLabel = file.scopeLabel || match.scopeLabel; file.rootLabel = file.rootLabel || match.rootLabel; file.module = file.module || match.module; file.version = file.version || match.version; file.unsaved = file.unsaved || match.unsaved;
        const duplicate = file.matches.some((item) => item.line === match.line && item.column === match.column && item.text === match.text);
        if (!duplicate) { file.matches.push(match); resultCount++; lastBatch.push(match); }
      });
      fileCount = files.size;
      render();
    }
    function displayFile(file) {
      const slash = String(file.relativePath || file.file).replace(/\\\\/g, '/');
      const pieces = slash.split('/');
      const name = pieces.pop() || slash;
      const parent = pieces.join('/');
      return { name: name + (file.unsaved ? ' •' : ''), parent };
    }
    function render() {
      if (fileCount === 0) { empty.hidden = false; return; }
      empty.hidden = true; results.querySelectorAll('.file').forEach((node) => node.remove());
      files.forEach((file) => {
        const wrap = document.createElement('section'); wrap.className = 'file' + (file.collapsed ? ' collapsed' : ''); wrap.setAttribute('role', 'treeitem');
        const shown = displayFile(file);
        wrap.innerHTML = '<div class="file-head" tabindex="0"><span class="twisty">' + icon('down') + '</span><span class="file-icon" aria-hidden="true">' + icon('go') + '</span><span class="file-name" title="' + esc(file.file) + '">' + esc(shown.name) + '</span><span class="file-path" title="' + esc(shown.parent) + '">' + esc(shown.parent) + '</span><span class="count">' + file.matches.length + '</span></div><div class="matches"></div>';
        const head = wrap.querySelector('.file-head'); head.addEventListener('click', () => { file.collapsed = !file.collapsed; wrap.classList.toggle('collapsed', file.collapsed); }); head.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); file.collapsed = !file.collapsed; wrap.classList.toggle('collapsed', file.collapsed); } });
        const list = wrap.querySelector('.matches'); file.matches.slice(0, 300).forEach((match) => { const row = document.createElement('div'); row.className = 'match'; row.setAttribute('role', 'treeitem'); row.title = 'Open ' + file.file + ':' + match.line; row.innerHTML = '<span class="line-number">' + esc(match.line) + ':</span><span class="match-text">' + highlight(match.preview) + '</span>'; row.addEventListener('click', () => vscode.postMessage({ type: 'openMatch', match })); list.appendChild(row); });
        if (file.matches.length > 300) { const more = document.createElement('div'); more.className = 'result-ellipsis'; more.textContent = '… ' + (file.matches.length - 300) + ' more matches'; list.appendChild(more); }
        results.appendChild(wrap);
      });
    }
    function updateStatus(cancelled) {
      progress.classList.toggle('busy', running);
      if (running) { status.textContent = resultCount ? 'Searching… ' + resultCount + ' result' + (resultCount === 1 ? '' : 's') : 'Searching…'; return; }
      if (!latestOptions.query) { status.textContent = 'Type to search source'; return; }
      if (cancelled) { status.textContent = resultCount ? resultCount + ' result' + (resultCount === 1 ? '' : 's') + ' (cancelled)' : 'Search cancelled'; return; }
      status.innerHTML = '<strong>' + resultCount + '</strong> result' + (resultCount === 1 ? '' : 's') + ' in <strong>' + fileCount + '</strong> file' + (fileCount === 1 ? '' : 's') + (truncated ? ' <span title="Result limit reached">(truncated)</span>' : '');
      openEditor.hidden = resultCount === 0;
    }
    window.addEventListener('message', (event) => {
      const message = event.data || {};
      switch (message.type) {
        case 'searchStarted': latestOptions = message.options || latestOptions; syncFilterButtons(latestOptions); reset(); running = true; updateStatus(); break;
        case 'appendResults': addMatches(message.results || message.batch || []); break;
        case 'searchProgress':
          if (Number.isFinite(message.totalMatches)) resultCount = Math.max(resultCount, message.totalMatches);
          if (Number.isFinite(message.totalFiles)) fileCount = Math.max(fileCount, message.totalFiles);
          truncated = truncated || !!message.truncated; updateStatus(); break;
        case 'searchFinished':
          if (Number.isFinite(message.resultCount)) resultCount = Math.max(resultCount, message.resultCount);
          if (Number.isFinite(message.fileCount)) fileCount = Math.max(fileCount, message.fileCount);
          truncated = truncated || !!message.truncated; running = false; updateStatus(!!message.cancelled); break;
        case 'searchError': running = false; updateStatus(); status.textContent = message.message || 'Search failed'; break;
        case 'clearResults': running = false; reset(); updateStatus(); break;
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
    }

    dispose() {
        this._cancelSearch();
        this._view = null;
        for (const item of this._disposables.splice(0)) {
            try { item.dispose(); } catch (_) {}
        }
    }
}

function isAbortError(error) {
    return !!error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function normalizeBatch(batch) {
    if (!batch) return [];
    if (Array.isArray(batch)) return batch;
    if (Array.isArray(batch.results)) return batch.results;
    if (Array.isArray(batch.matches)) {
        if (batch.file || batch.path || batch.filePath) return [batch];
        return batch.matches;
    }
    return [batch];
}

function iconChevronSvg() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 3.5 4.5 4.5-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function iconRegexSvg() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M2.5 4.2l11 7.6M13.5 4.2l-11 7.6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="currentColor"/></svg>';
}
function iconCompassSvg() {
    return '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m20.4 11.6-2.8 6.1-6 2.7 2.8-6.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
}

module.exports = {
    SourceSearchViewProvider,
    SOURCE_SEARCH_VIEW_TYPE: VIEW_TYPE,
    normalizeBatch,
};
