// src/providers/openaiProvider.ts

import OpenAI from 'openai';
import { AIProvider, Message } from './aiProvider';

export class OpenAIProvider implements AIProvider {
    private client: OpenAI;
    private model: string;

    constructor(apiKey: string, model: string) {
        this.client = new OpenAI({ apiKey });
        this.model = model;
    }

    async sendMessage(messages: Message[], systemContext: string): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: systemContext },
                ...messages,
            ],
        });
        return response.choices[0]?.message?.content ?? '(ingen tekst i svar)';
    }
}