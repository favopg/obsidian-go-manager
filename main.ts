import { Plugin } from 'obsidian';

export default class GoManagerPlugin extends Plugin {
    async onload() {
        this.addCommand({
            id: 'create_show_data',
            name: 'Create Show Data',
            callback: () => {
                console.log('ハローワールド');
            },
        });
    }
}
