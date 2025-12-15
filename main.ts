import { App, Plugin, PluginSettingTab, Setting, MarkdownView } from 'obsidian';

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

        // Command: overwrite active Markdown file with "ハローワールド"
        this.addCommand({
            id: 'create_show_data',
            name: 'Create Show Data',
            callback: async () => {
                const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
                const file = mdView?.file;
                if (file) {
                    await this.app.vault.modify(file, 'ハローワールド');
                }
            },
        });

        // Settings tab (gear icon)
        this.addSettingTab(new GoManagerSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
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
