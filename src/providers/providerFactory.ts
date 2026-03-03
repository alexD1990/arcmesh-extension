// src/providers/providerFactory.ts

import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';
import { AnthropicProvider } from './anthropicProvider';
import { OpenAIProvider } from './openaiProvider';
import { GoogleProvider } from './googleProvider';

export interface ModelConfig {
    provider: string;
    name: string;
}

export function createProvider(config: ModelConfig): AIProvider {
    const cfg = vscode.workspace.getConfiguration('contextos');

    switch (config.provider) {
        case 'openai': {
            const apiKey = cfg.get<string>('openaiApiKey');
            if (!apiKey) throw new Error('⚠️ Sett contextos.openaiApiKey i VS Code settings.');
            return new OpenAIProvider(apiKey, config.name);
        }
        case 'google': {
            const apiKey = cfg.get<string>('googleApiKey');
            if (!apiKey) throw new Error('⚠️ Sett contextos.googleApiKey i VS Code settings.');
            return new GoogleProvider(apiKey, config.name);
        }
        case 'anthropic':
        default: {
            const apiKey = cfg.get<string>('apiKey');
            if (!apiKey) throw new Error('⚠️ Sett contextos.apiKey i VS Code settings.');
            return new AnthropicProvider(apiKey, config.name);
        }
    }
}