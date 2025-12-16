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
}

const DEFAULT_SETTINGS: GoManagerSettings = {
    sgfFolderPath: '',
    boardSize: 19,
    importSgfDirPath: '',
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

                    // バッククオートやテンプレート文字列のエスケープに注意して構築
                    const content = [
                        '```dataviewjs',
                        '// SGFフォルダ直下およびサブフォルダのSGFを一覧表示する',
                        `const ROOT = ${JSON.stringify(folderPathForCode)};`,
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
                        '  let total = 0; // 総対局数',
                        '  let blackWins = 0; // 黒の勝ち数',
                        '  let whiteWins = 0; // 白の勝ち数',
                        '  for (const f of files){',
                        '    let src = "";',
                        '    try { src = await vault.read(f); } catch(e) { src = ""; }',
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
                        '    // ファイル名のリンク（Obsidianリンク記法）',
                        '    const link = `[[${f.path}|${f.name}]]`;',
                        '    rows.push([pb, pw, gn, ha, re, link]);',
                        '  }',
                        '  // 上部にサマリー表示',
                        '  const pct = (n, d) => d ? (Math.round((n * 1000) / d) / 10).toFixed(1) : "0.0";',
                        '  dv.paragraph(`対局数: ${total}局　黒: ${blackWins}勝　白: ${whiteWins}勝`);',
                        '  dv.paragraph(`黒勝率: ${pct(blackWins, total)}%　白勝率: ${pct(whiteWins, total)}%`);',
                        '  // ヘッダ: 黒番, 白番, 対局内容, 手合い割, 結果, 棋譜(SGFファイル名)',
                        '  dv.table(["黒番","白番","対局内容","手合い割","結果","棋譜(SGFファイル名)"], rows);',
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
    }
}

// OSに応じたデフォルトのダウンロードフォルダを返す
function getDefaultDownloadsDir(): string {
    const home = os.homedir?.() || '';
    if (!home) return 'Downloads';
    // Windows / macOS / Linux いずれも一般的にホーム直下のDownloadsを想定
    return path.join(home, 'Downloads');
}
