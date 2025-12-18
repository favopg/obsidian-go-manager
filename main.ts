import { App, Plugin, PluginSettingTab, Setting, MarkdownView, Modal, TFolder, Notice } from 'obsidian';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

interface GoManagerSettings {
    sgfFolderPath: string;
    // 碁盤サイズ（9/13/19）
    boardSize: 9 | 13 | 19;
    // ローカルファイルシステム上の、インポート元SGFディレクトリ（例: C:\Users\<User>\Downloads）
    importSgfDirPath?: string;
    // 座標と布石名のセット一覧（例: x:4, y:4, name:"星"）
    fusekiPairs?: { x: number; y: number; name: string }[];
}

const DEFAULT_SETTINGS: GoManagerSettings = {
    sgfFolderPath: '',
    boardSize: 19,
    importSgfDirPath: '',
    fusekiPairs: [],
};

export default class GoManagerPlugin extends Plugin {
    settings: GoManagerSettings;

    async onload() {
        await this.loadSettings();

        // インポート元SGFディレクトリのデフォルトをローカルのダウンロードフォルダに初期化
        if (!this.settings.importSgfDirPath || this.settings.importSgfDirPath.trim() === '') {
            try {
                const downloads = getDefaultDownloadsDir();
                if (downloads) {
                    this.settings.importSgfDirPath = downloads;
                    await this.saveSettings();
                }
            } catch (_) {
                // 失敗しても致命的ではないので無視
            }
        }

        // 作業用コマンド: アクティブなMarkdownファイルを「ハローワールド」で上書きする
        this.addCommand({
            id: 'create_show_data',
            name: 'Create Show Data',
            callback: async () => {
                // 0) 依存プラグインの有効化チェック
                try {
                    // 型定義上 App.plugins が存在しない環境向けに any キャストで回避
                    const enabled = (this.app as any)?.plugins?.enabledPlugins as Set<string> | undefined;
                    const isGVEnabled = !!enabled && enabled.has('goboard-viewer');
                    const isDVEnabled = !!enabled && enabled.has('dataview');

                    // Go Board Viewer が無効でも一覧作成は続行する（通知のみ）
                    if (!isGVEnabled) {
                        new ErrorModal(this.app, '棋譜を参照できないので、Go Board Viewerコミュニティプラグインを有効化してください').open();
                    }

                    // Dataview が無効なら一覧作成はできないため、通知して終了
                    if (!isDVEnabled) {
                        new ErrorModal(this.app, 'SGFから一覧を作成することができないので、Dataviewコミュニティプラグインを有効化してください').open();
                        return;
                    }
                } catch (_) {
                    // 何らかの理由でプラグイン情報が取得できない場合は続行（既存動作を壊さない）
                }
                // 1) 設定のフォルダ名が存在するかチェック（未設定・不存在ならモーダルで通知して終了）
                const folderPath = (this.settings.sgfFolderPath || '').trim();
                if (!folderPath) {
                    new ErrorModal(this.app, 'エラー: 設定の「SGFフォルダ」が未設定です。設定からフォルダを指定してください。').open();
                    return;
                }

                const abstract = this.app.vault.getAbstractFileByPath(folderPath);
                if (!(abstract instanceof TFolder)) {
                    new ErrorModal(this.app, `エラー: 指定されたフォルダが見つかりませんでした: "${folderPath}"\n正しいフォルダ名を設定で指定してください。`).open();
                    return;
                }

                // 2) フォルダが存在する場合のみ、アクティブなMarkdownにDataviewJSでSGF一覧テーブルを生成するコードを書き込む
                const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
                const file = mdView?.file;
                if (file) {
                    // DataviewJSコードブロックを生成（サブフォルダを含めて*.sgfを走査し、ヘッダ/ボディ仕様で出力）
                    const folderPathForCode = folderPath; // そのままコードブロックへ埋め込み
                    const selectedBoardSize = this.settings.boardSize; // 設定の碁盤サイズ（9/13/19）

                    // バッククオートやテンプレート文字列のエスケープに注意して構築
                    const content = [
                        '```dataviewjs',
                        '// SGFフォルダ直下およびサブフォルダのSGFを一覧表示する',
                        `const ROOT = ${JSON.stringify(folderPathForCode)};`,
                        `const FILTER_SZ = ${JSON.stringify(selectedBoardSize)}; // 設定で選択された碁盤サイズ`,
                        `const FUSEKI = ${JSON.stringify(this.settings.fusekiPairs || [])}; // 設定の「座標と布石」一覧（1始まりの座標）`,
                        'const FUSEKI_MOVES_LIMIT = 7; // 先7手以内に含まれていれば件数あり',
                        '',
                        '// Obsidian APIを使ってフォルダ配下を再帰走査',
                        'const {vault} = app;',
                        'const TFolderCls = app.vault.constructor.prototype.constructor; // 型は不要（実行時評価のみ）',
                        '',
                        '// TFolder/TFileの区別用（DataviewJS環境では型は不要）',
                        'const isFolder = (af) => af?.children !== undefined;',
                        'const isFile = (af) => af?.extension !== undefined;',
                        '',
                        'function walkSgfFiles(folderPath){',
                        '  const root = vault.getAbstractFileByPath(folderPath);',
                        '  const results = [];',
                        '  if(!root) return results;',
                        '  const stack = [root];',
                        '  while(stack.length){',
                        '    const cur = stack.pop();',
                        '    if(isFolder(cur)){',
                        '      for(const ch of cur.children){ stack.push(ch); }',
                        '    } else if(isFile(cur)) {',
                        "      if ((cur.extension || '').toLowerCase() === 'sgf') results.push(cur);",
                        '    }',
                        '  }',
                        '  return results;',
                        '}',
                        '',
                        '// SGFタグ抽出用の簡易正規表現（最初の値のみ取得）',
                        'const tag = (src, key) => {',
                        "  // SGFは 'PB[名前]' のように括弧は使わないため、キー直後の [] を抽出する", 
                        "  // ノード先頭 ';' / 空白 / 直前が']'や'('のケースにもマッチさせる（例: SZ[19]PB[...])",
                        "  const re = new RegExp('(?:^|[;\\\\s\\\\(\\\\]])' + key + '\\\\s*\\\\[([^\\\\]]*)\\\\]');",
                        '  const m = src.match(re);',
                        '  return m ? m[1].trim() : "";',
                        '};',
                        '',
                        '// 手合い割(HA)の表示変換: 未設定→互戦、数字→「n子」',
                        'const toHandicap = (haRaw) => {',
                        '  if(!haRaw) return "互戦";',
                        '  const n = parseInt(haRaw, 10);',
                        '  if(!Number.isFinite(n) || n === 0) return "互戦";',
                        '  return `${n}子`;',
                        '};',
                        '',
                        '// 結果(RE)の日本語変換',
                        'const toJapaneseResult = (reRaw) => {',
                        '  if(!reRaw) return "";',
                        '  const s = reRaw.trim();',
                        '  // 例: B+R, W+T, B+F, W+3.5, B+2',
                        '  const color = s.startsWith("B+") ? "黒" : s.startsWith("W+") ? "白" : "";',
                        '  if(color){',
                        '    const rest = s.slice(2);',
                        '    if(rest === "R") return `${color}中押し勝ち`;',
                        '    if(rest === "T") return `${color}時間切れ勝ち`;',
                        '    if(rest === "F") return `${color}反則勝ち`;',
                        '    // 数目勝ち（小数0.5は「半」表記）',
                        '    const num = Number(rest);',
                        '    if(!Number.isNaN(num)){',
                        '      if(Number.isInteger(num)) return `${color}${num}目勝ち`;',
                        '      // 0.5を含む場合',
                        '      const jp = (n)=> { const int = Math.floor(n); const frac = n - int; return frac === 0.5 ? `${int}目半勝ち` : `${n}目勝ち`; };',
                        '      return `${color}${jp(num)}`;',
                        '    }',
                        '  }',
                        '  // それ以外（例外ケース）は原文を返す',
                        '  return s;',
                        '};',
                        '',
                        '(async () => {',
                        '  const files = walkSgfFiles(ROOT);',
                        '  const rows = [];',
                        '  let total = 0; // 総対局数（指定サイズのみ）',
                        '  let blackWins = 0; // 黒の勝ち数（指定サイズのみ）',
                        '  let whiteWins = 0; // 白の勝ち数（指定サイズのみ）',
                        '  // 設定布石を名前ごとにグルーピング',
                        '  const FUSEKI_GROUPS = (() => {',
                        '    const map = new Map(); // name -> coords[]',
                        '    const valid = Array.isArray(FUSEKI) ? FUSEKI.filter(p => p && Number(p.x) > 0 && Number(p.y) > 0) : [];',
                        '    for (const p of valid) {',
                        '      const name = String(p.name || "布石");',
                        '      if (!map.has(name)) map.set(name, []);',
                        '      map.get(name).push({ x: Number(p.x), y: Number(p.y) });',
                        '    }',
                        '    return Array.from(map.entries()).map(([name, coords]) => ({ name, coords }));',
                        '  })();',
                        '  // 名前ごとの集計オブジェクト（name -> { total, b, w }）',
                        '  const fusekiStats = {};',
                        '  for (const g of FUSEKI_GROUPS) {',
                        '    fusekiStats[g.name] = { total: 0, b: 0, w: 0 };',
                        '  }',
                        '  for (const f of files){',
                        '    let src = "";',
                        '    try { src = await vault.read(f); } catch(e) { src = ""; }',
                        '',
                        '    // 盤サイズ(SZ)でフィルタリング',
                        '    const szRaw = tag(src, "SZ");',
                        '    const sz = parseInt(szRaw, 10);',
                        '    if (!Number.isFinite(sz) || sz !== FILTER_SZ) {',
                        '      continue;',
                        '    }',
                        '',
                        '    // 先7手の座標と色を抽出（SGF座標: a=1, b=2, ...）',
                        '    const toXY = (cc) => {',
                        '      if (!cc || cc.length < 2) return null;',
                        '      const x = cc.charCodeAt(0) - 96; // "a"(97)->1',
                        '      const y = cc.charCodeAt(1) - 96;',
                        '      if (x <= 0 || y <= 0) return null;',
                        '      return {x, y}; // 1始まり',
                        '    };',
                        '    const moves = []; // { x, y, color: "B" | "W" }',
                        '    try {',
                        '      // 注意: この文字列はさらにDataviewJS内で評価されるため、\\[ / \\] を二重にエスケープして出力する',
                        '      const re = /;([BW])\\[([a-z]{0,2})\\]/g;',
                        '      let m; let count = 0;',
                        '      while ((m = re.exec(src)) && count < FUSEKI_MOVES_LIMIT) {',
                        '        const color = m[1];',
                        '        const c = (m[2] || "");',
                        '        if (c.length === 2) {',
                        '          const pt = toXY(c);',
                        '          if (pt) { moves.push({ ...pt, color }); count++; }',
                        '        }',
                        '      }',
                        '    } catch (_) {}',
                        '',
                        '    const pb = tag(src, "PB");',
                        '    const pw = tag(src, "PW");',
                        '    const gn = tag(src, "GN");',
                        '    const ha = toHandicap(tag(src, "HA"));',
                        '    const reRaw = tag(src, "RE");',
                        '    const re = toJapaneseResult(reRaw);',
                        '    // 勝敗カウント',
                        '    total++;',
                        '    if (reRaw?.startsWith("B+")) blackWins++;',
                        '    else if (reRaw?.startsWith("W+")) whiteWins++;',
                        '    // 布石（名前ごと）該当の勝敗カウント',
                        '    // 要件: 「黒 or 白が指定座標すべてを同色で打っている場合のみ」カウント',
                        '    for (const g of FUSEKI_GROUPS) {',
                        '      const hasSameColorAll = (color) =>',
                        '        g.coords.every(c => moves.some(m => m.color === color && m.x === c.x && m.y === c.y));',
                        '      const has = hasSameColorAll("B") || hasSameColorAll("W");',
                        '      if (has) {',
                        '        const s = fusekiStats[g.name];',
                        '        s.total++;',
                        '        if (reRaw?.startsWith("B+")) s.b++;',
                        '        else if (reRaw?.startsWith("W+")) s.w++;',
                        '      }',
                        '    }',
                        '    // ファイル名のリンク（Obsidianリンク記法）',
                        '    const link = `[[${f.path}|${f.name}]]`;',
                        '    rows.push([pb, pw, gn, ha, re, link]);',
                        '  }',
                        '  // 上部にサマリー表示',
                        '  const pct = (n, d) => d ? (Math.round((n * 1000) / d) / 10).toFixed(1) : "0.0";',
                        '  dv.paragraph(`表示対象: ${FILTER_SZ}路`);',
                        '  dv.paragraph(`対局数: ${total}局　黒: ${blackWins}勝　白: ${whiteWins}勝`);',
                        '  dv.paragraph(`黒勝率: ${pct(blackWins, total)}%　白勝率: ${pct(whiteWins, total)}%`);',
                        '  // 設定された布石（座標）の集計結果表示（名前ごと）',
                        '  if (Array.isArray(FUSEKI) && FUSEKI.length > 0) {',
                        '    if (FUSEKI_GROUPS.length === 0) {',
                        '      dv.paragraph(`布石の総対局数: 0局`);',
                        '      dv.paragraph(`布石の勝率　黒勝率: 0.0%　白勝率: 0.0%`);',
                        '    } else {',
                        '      for (const g of FUSEKI_GROUPS) {',
                        '        const s = fusekiStats[g.name] || { total: 0, b: 0, w: 0 };',
                        '        dv.paragraph(`${g.name}の総対局数: ${s.total}局`);',
                        '        dv.paragraph(`${g.name}の勝率　黒勝率: ${pct(s.b, s.total)}%　白勝率: ${pct(s.w, s.total)}%`);',
                        '      }',
                        '    }',
                        '  } else {',
                        '    dv.paragraph(`布石の総対局数: 0局`);',
                        '    dv.paragraph(`布石の勝率　黒勝率: 0.0%　白勝率: 0.0%`);',
                        '  }',
                        '',
                        '  // 勝率の下にテキストボックス（ソート対象）を追加',
                        '  const controlDiv = document.createElement("div");',
                        '  controlDiv.style.margin = "8px 0 12px";',
                        '  const label = document.createElement("label");',
                        '  label.textContent = "ソート対象：対局者を入力 ";',
                        '  const input = document.createElement("input");',
                        '  input.type = "text";',
                        '  input.placeholder = "例: 井山裕太 / 一力遼 など";',
                        '  // プレースホルダーが見切れないよう幅を十分に確保',
                        '  input.style.width = "28em";',
                        '  input.style.maxWidth = "100%";',
                        '  input.style.boxSizing = "border-box";',
                        '  input.style.marginLeft = "4px";',
                        '  label.appendChild(input);',
                        '  controlDiv.appendChild(label);',
                        '  dv.container.appendChild(controlDiv);',
                        '',
                        '  // rowsを描画する関数（入力に一致する黒番/白番を優先してソート）',
                        '  const header = ["黒番","白番","対局内容","手合い割","結果","棋譜(SGFファイル名)"];',
                        '  const render = (keyword) => {',
                        '    // 既存のテーブルがあれば削除（dv.tableは直接DOMに追加するため、container内の最後のtableを探す）',
                        '    const tables = Array.from(dv.container.querySelectorAll("table"));',
                        '    if (tables.length) { tables[tables.length - 1].remove(); }',
                        '    const kw = (keyword || "").trim();',
                        '    if (!kw) {',
                        '      dv.table(header, rows);',
                        '      return;',
                        '    }',
                        '    const norm = (s) => (s || "").toLowerCase();',
                        '    const sorted = [...rows].sort((a, b) => {',
                        '      // a,b: [pb, pw, gn, ha, re, link]',
                        '      const ak = (norm(a[0]) === norm(kw) || norm(a[1]) === norm(kw)) ? 1 : 0;',
                        '      const bk = (norm(b[0]) === norm(kw) || norm(b[1]) === norm(kw)) ? 1 : 0;',
                        '      if (ak !== bk) return bk - ak; // 一致ありを上位に',
                        '      // 次基準: 黒番・白番の部分一致（含む）',
                        '      const apart = (norm(a[0]).includes(norm(kw)) || norm(a[1]).includes(norm(kw))) ? 1 : 0;',
                        '      const bpart = (norm(b[0]).includes(norm(kw)) || norm(b[1]).includes(norm(kw))) ? 1 : 0;',
                        '      if (apart !== bpart) return bpart - apart;',
                        '      return 0;',
                        '    });',
                        '    dv.table(header, sorted);',
                        '  };',
                        '',
                        '  // 初期表示',
                        '  render("");',
                        '  // 入力イベントで再描画',
                        '  input.addEventListener("input", () => render(input.value));',
                        '})();',
                        '```',
                    ].join('\n');

                    await this.app.vault.modify(file, content);
                }
            },
        });

        // Import SGF Local: ローカルのインポート元SGFディレクトリからVault内のSGFディレクトリへ.sgfを移動
        this.addCommand({
            id: 'import_sgf_local',
            name: 'Import SGF Local',
            callback: async () => {
                try {
                    const srcDir = (this.settings.importSgfDirPath || '').trim();
                    const vaultDstRoot = (this.settings.sgfFolderPath || '').trim();

                    if (!vaultDstRoot) {
                        new ErrorModal(this.app, 'エラー: 設定の「SGFフォルダ」が未設定です。設定からフォルダを指定してください。').open();
                        return;
                    }

                    // Vault内のフォルダを確認（無ければ作成）
                    const ensureVaultFolder = async (folderPath: string) => {
                        const existing = this.app.vault.getAbstractFileByPath(folderPath);
                        if (existing instanceof TFolder) return;
                        await this.app.vault.createFolder(folderPath);
                    };

                    // OS上のディレクトリ存在チェック
                    if (!srcDir) {
                        new ErrorModal(this.app, 'エラー: 設定の「インポート元SGFディレクトリ」が未設定です。設定からディレクトリを指定してください。').open();
                        return;
                    }
                    let stat: fs.Stats | undefined;
                    try {
                        stat = await fsp.stat(srcDir);
                    } catch (_) {
                        stat = undefined;
                    }
                    if (!stat || !stat.isDirectory()) {
                        new ErrorModal(this.app, `エラー: インポート元SGFディレクトリが見つかりません: "${srcDir}"`).open();
                        return;
                    }

                    await ensureVaultFolder(vaultDstRoot);

                    // ユニークなVault内ファイルパスを作る
                    const getUniqueVaultPath = async (baseFolder: string, baseName: string): Promise<string> => {
                        const norm = baseFolder.endsWith('/') ? baseFolder.slice(0, -1) : baseFolder;
                        const ext = path.extname(baseName);
                        const nameOnly = path.basename(baseName, ext);
                        let candidate = `${norm}/${baseName}`;
                        let i = 1;
                        while (this.app.vault.getAbstractFileByPath(candidate)) {
                            candidate = `${norm}/${nameOnly} (${i})${ext}`;
                            i++;
                        }
                        return candidate;
                    };

                    // srcDir内の*.sgfを列挙
                    const entries = await fsp.readdir(srcDir, { withFileTypes: true });
                    const sgfFiles = entries
                        .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.sgf')
                        .map((e) => e.name);

                    for (const fname of sgfFiles) {
                        const abs = path.join(srcDir, fname);
                        // 文字コードは中身としてVaultに保存するだけなのでバイナリ→utf8文字列で良い
                        // SGFはテキスト形式
                        let data: string;
                        try {
                            data = await fsp.readFile(abs, 'utf8');
                        } catch {
                            // 読み込み失敗時はスキップ
                            continue;
                        }

                        // 保存先のVaultパス（フォルダはVault相対、区切りは/）
                        const uniquePath = await getUniqueVaultPath(vaultDstRoot, fname);
                        try {
                            await this.app.vault.create(uniquePath, data);
                            // 作成に成功したら元ファイルを削除して「移動」完了
                            try { await fsp.unlink(abs); } catch { /* ignore unlink errors */ }
                        } catch {
                            // 既存や一時的エラーはスキップ
                        }
                    }

                    const message = `${srcDir}のSGFファイルをSGFディレクトリにインポートしました。`;
                    new Notice(message, 8000);
                } catch (e: any) {
                    new ErrorModal(this.app, `インポート処理中にエラーが発生しました。\n${e?.message || e}`).open();
                }
            },
        });

        // 設定タブ（歯車アイコン）
        this.addSettingTab(new GoManagerSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// シンプルなエラーモーダル（日本語メッセージ表示）
class ErrorModal extends Modal {
    private message: string;

    constructor(app: App, message: string) {
        super(app);
        this.message = message;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Go Manager エラー' });
        contentEl.createEl('p', { text: this.message });
        const footer = contentEl.createEl('div', { attr: { style: 'margin-top: 1rem; text-align: right;' } });
        const button = footer.createEl('button', { text: '閉じる' });
        button.addEventListener('click', () => this.close());
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class GoManagerSettingTab extends PluginSettingTab {
    plugin: GoManagerPlugin;

    constructor(app: App, plugin: GoManagerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h3', { text: 'Go Manager 設定' });

        // インポート元SGFディレクトリ（ローカルのOSパスを直接指定 or フォルダ選択）
        new Setting(containerEl)
            .setName('インポート元SGFディレクトリ')
            .setDesc('ローカルPC上のSGFファイルが置いてあるフォルダへのフルパスを指定します（デフォルト: ダウンロードフォルダ）。')
            .addText((text) => {
                text.setPlaceholder(getDefaultDownloadsDir())
                    .setValue((this.plugin.settings.importSgfDirPath || ''))
                    .onChange(async (value) => {
                        this.plugin.settings.importSgfDirPath = value.trim();
                        await this.plugin.saveSettings();
                    });
            })
            .addButton((btn) => {
                btn.setButtonText('フォルダを選択').onClick(async () => {
                    // まずは Electron の directory picker を優先して使用（"アップロード"ダイアログを回避）
                    try {
                        const req = (window as any).require?.('electron');
                        const dialog = req?.remote?.dialog || req?.dialog;
                        if (dialog?.showOpenDialog) {
                            const result = await dialog.showOpenDialog({
                                properties: ['openDirectory', 'dontAddToRecent'],
                                title: 'フォルダーの選択',
                            });
                            if (result.canceled || !result.filePaths?.length) return;
                            const chosenAbs = result.filePaths[0];
                            if (chosenAbs) {
                                this.plugin.settings.importSgfDirPath = chosenAbs;
                                await this.plugin.saveSettings();
                                this.display();
                                return;
                            }
                        }
                    } catch (_) {
                        // フォールバックに進む
                    }

                    // フォールバック: ディレクトリを選択するための隠しファイル入力（webkitdirectory対応）
                    const input = document.createElement('input');
                    input.type = 'file';
                    // @ts-ignore - Electron/Chromium supports webkitdirectory
                    input.webkitdirectory = true;
                    // @ts-ignore
                    input.directory = true;
                    input.style.display = 'none';

                    input.addEventListener('change', async () => {
                        const files = Array.from(input.files || []);
                        if (files.length === 0) return;

                        const first = files[0] as File & { webkitRelativePath?: string } & { path?: string };
                        const rel = (first.webkitRelativePath || '');
                        const abs = (first as any).path as string | undefined;

                        let chosen = '';
                        if (abs && rel) {
                            // rel = Root/Sub/.../file.ext
                            // depth = ディレクトリ階層の数（ファイル名を除く）
                            const parts = rel.split('/');
                            const depth = Math.max(0, parts.length - 1);
                            let dir = path.dirname(abs);
                            for (let i = 0; i < depth; i++) {
                                dir = path.dirname(dir);
                            }
                            chosen = dir;
                        } else if (abs) {
                            // webkitRelativePathが無い場合は親ディレクトリを使用
                            chosen = path.dirname(abs);
                        } else if (rel) {
                            // 最低限、フォルダ名（最上位）を設定
                            chosen = rel.split('/')[0] || '';
                        }

                        if (chosen) {
                            this.plugin.settings.importSgfDirPath = chosen;
                            await this.plugin.saveSettings();
                            this.display();
                        }
                    });

                    document.body.appendChild(input);
                    input.click();
                    setTimeout(() => input.remove(), 0);
                });
            });

        // SGFフォルダ設定
        new Setting(containerEl)
            .setName('SGFフォルダ')
            .setDesc('エクスプローラーからSGFファイルのフォルダを選択します。')
            .addText((text) => {
                text.setPlaceholder('例: SGF')
                    .setValue(this.plugin.settings.sgfFolderPath || '')
                    .onChange(async (value) => {
                        this.plugin.settings.sgfFolderPath = value.trim();
                        await this.plugin.saveSettings();
                    });
            })
            .addButton((btn) => {
                btn.setButtonText('フォルダを選択').onClick(async () => {
                    // Create a hidden directory picker input
                    const input = document.createElement('input');
                    input.type = 'file';
                    // @ts-ignore - Electron/Chromium supports webkitdirectory
                    input.webkitdirectory = true;
                    // @ts-ignore
                    input.directory = true;
                    input.style.display = 'none';

                    input.addEventListener('change', async () => {
                        const files = Array.from(input.files || []);
                        if (files.length === 0) return;

                        // Derive the selected root folder name from webkitRelativePath
                        // e.g., `MyFolder/a.sgf` -> `MyFolder`
                        const first = files[0] as File & { webkitRelativePath?: string };
                        const rel = (first.webkitRelativePath || '').split('/');
                        const root = rel.length > 0 ? rel[0] : '';

                        // Fallback: if webkitRelativePath isn't available, try to use name of parent
                        const chosen = root || '選択されたフォルダ';
                        this.plugin.settings.sgfFolderPath = chosen;
                        await this.plugin.saveSettings();
                        this.display();
                    });

                    document.body.appendChild(input);
                    input.click();
                    // Clean up element after use
                    setTimeout(() => input.remove(), 0);
                });
            });

        // 碁盤サイズ設定（ドロップダウン 9/13/19, デフォルト19）
        new Setting(containerEl)
            .setName('碁盤の大きさ')
            .setDesc('碁盤サイズを選択します（9路 / 13路 / 19路）。')
            .addDropdown((dd) => {
                dd.addOption('9', '9路');
                dd.addOption('13', '13路');
                dd.addOption('19', '19路');
                dd.setValue(String(this.plugin.settings.boardSize ?? 19));
                dd.onChange(async (value) => {
                    const v = Number(value) as 9 | 13 | 19;
                    this.plugin.settings.boardSize = v;
                    await this.plugin.saveSettings();
                });
            });

        // 座標と布石のセット
        containerEl.createEl('h4', { text: '座標と布石のセット' });
        containerEl.createEl('p', { text: '例）座標: 4,4　布石: 星（数値は1始まり）' });

        // 設定の後方互換（undefinedのとき空配列に）
        if (!Array.isArray(this.plugin.settings.fusekiPairs)) {
            this.plugin.settings.fusekiPairs = [];
        }

        const pairListEl = containerEl.createEl('div');

        const renderPairs = () => {
            pairListEl.empty();
            (this.plugin.settings.fusekiPairs || []).forEach((p, idx) => {
                const s = new Setting(pairListEl).setName(`セット ${idx + 1}`);
                s.addText((tx) => {
                    tx.setPlaceholder('x')
                        .setValue(p?.x !== undefined ? String(p.x) : '')
                        .onChange(async (v) => {
                            const n = Number(v);
                            this.plugin.settings.fusekiPairs![idx].x = Number.isFinite(n) ? n : 0;
                            await this.plugin.saveSettings();
                        });
                });
                s.addText((ty) => {
                    ty.setPlaceholder('y')
                        .setValue(p?.y !== undefined ? String(p.y) : '')
                        .onChange(async (v) => {
                            const n = Number(v);
                            this.plugin.settings.fusekiPairs![idx].y = Number.isFinite(n) ? n : 0;
                            await this.plugin.saveSettings();
                        });
                });
                s.addText((tn) => {
                    tn.setPlaceholder('布石名（例: 星）')
                        .setValue(p?.name ?? '')
                        .onChange(async (v) => {
                            this.plugin.settings.fusekiPairs![idx].name = v.trim();
                            await this.plugin.saveSettings();
                        });
                });
                s.addExtraButton((b) => {
                    b.setIcon('cross');
                    b.setTooltip('削除');
                    b.onClick(async () => {
                        this.plugin.settings.fusekiPairs!.splice(idx, 1);
                        await this.plugin.saveSettings();
                        renderPairs();
                    });
                });
            });
        };

        renderPairs();

        new Setting(containerEl)
            .setName('セットの追加')
            .setDesc('新しい「座標, 布石」ペアを追加します。')
            .addButton((btn) => {
                btn.setButtonText('追加').onClick(async () => {
                    this.plugin.settings.fusekiPairs = this.plugin.settings.fusekiPairs || [];
                    this.plugin.settings.fusekiPairs.push({ x: 4, y: 4, name: '星' });
                    await this.plugin.saveSettings();
                    renderPairs();
                });
            });
    }
}

// OSに応じたデフォルトのダウンロードフォルダを返す
function getDefaultDownloadsDir(): string {
    const home = os.homedir?.() || '';
    if (!home) return 'Downloads';
    // Windows / macOS / Linux いずれも一般的にホーム直下のDownloadsを想定
    return path.join(home, 'Downloads');
}
