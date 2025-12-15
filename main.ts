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

                // 2) フォルダが存在する場合のみ、アクティブなMarkdownを上書き
                const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
                const file = mdView?.file;
                if (file) {
                    await this.app.vault.modify(file, 'ハローワールド');
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
