// src/providers/googleProvider.ts

import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider, Message } from './aiProvider';

export class GoogleProvider implements AIProvider {
    private client: GoogleGenerativeAI;
    private model: string;

    constructor(apiKey: string, model: string) {
        this.client = new GoogleGenerativeAI(apiKey);
        this.model = model;
    }

    async sendMessage(messages: Message[], systemContext: string): Promise<string> {
        const genModel = this.client.getGenerativeModel({
            model: this.model,
            systemInstruction: systemContext,
        });

        const history = messages.slice(0, -1).map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));

        const lastMessage = messages[messages.length - 1].content;
        const chat = genModel.startChat({ history });
        const result = await chat.sendMessage(lastMessage);
        return result.response.text();
    }
}