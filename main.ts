import { App, Plugin, PluginSettingTab, Setting, MarkdownView, Modal, TFolder } from 'obsidian';

interface GoManagerSettings {
    sgfFolderPath: string;
}

const DEFAULT_SETTINGS: GoManagerSettings = {
    sgfFolderPath: '',
};

export default class GoManagerPlugin extends Plugin {
    settings: GoManagerSettings;

    async onload() {
        await this.loadSettings();

        // 作業用コマンド: アクティブなMarkdownファイルを「ハローワールド」で上書きする
        this.addCommand({
            id: 'create_show_data',
            name: 'Create Show Data',
            callback: async () => {
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
                        '  for (const f of files){',
                        '    let src = "";',
                        '    try { src = await vault.read(f); } catch(e) { src = ""; }',
                        '',
                        '    const pb = tag(src, "PB");',
                        '    const pw = tag(src, "PW");',
                        '    const gn = tag(src, "GN");',
                        '    const ha = toHandicap(tag(src, "HA"));',
                        '    const re = toJapaneseResult(tag(src, "RE"));',
                        '    // ファイル名のリンク（Obsidianリンク記法）',
                        '    const link = `[[${f.path}|${f.name}]]`;',
                        '    rows.push([pb, pw, gn, ha, re, link]);',
                        '  }',
                        '  // ヘッダ: 黒番, 白番, 対局内容, 手合い割, 結果, 棋譜(SGFファイル名)',
                        '  dv.table(["黒番","白番","対局内容","手合い割","結果","棋譜(SGFファイル名)"], rows);',
                        '})();',
                        '```',
                    ].join('\n');

                    await this.app.vault.modify(file, content);
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
    }
}
