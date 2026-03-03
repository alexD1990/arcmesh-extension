// src/providers/aiProvider.ts

export interface Message {
    role: 'user' | 'assistant';
    content: string;
}

export interface AIProvider {
    sendMessage(messages: Message[], systemContext: string): Promise<string>;
}