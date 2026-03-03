// src/providers/anthropicProvider.ts

import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, Message } from './aiProvider';

export class AnthropicProvider implements AIProvider {
    private client: Anthropic;
    private model: string;

    constructor(apiKey: string, model: string) {
        this.client = new Anthropic({ apiKey });
        this.model = model;
    }

    async sendMessage(messages: Message[], systemContext: string): Promise<string> {
        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 1024,
            system: systemContext,
            messages,
        });
        const block = response.content[0];
        return block.type === 'text' ? block.text : '(ingen tekst i svar)';
    }
}