import * as path from 'path';

/**
 * Matcher en endret fil mot context_map-nøkler.
 * Støtter prefix-match (f.eks. "src/components/") og glob-mønster med * (f.eks. "*.config.*").
 */
function matchesPattern(filePath: string, pattern: string): boolean {
    if (pattern.includes('*')) {
        const regexStr = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(regexStr).test(path.basename(filePath));
    }
    return filePath.startsWith(pattern);
}

/**
 * Mapper endrede filer til relevante system-repo-stier via context_map.
 * Returnerer deduplisert liste av matchede stier.
 * Fallback: ['project.md', 'changelog.md'] hvis ingen treff.
 */
export function resolveContext(
    changedFiles: string[],
    contextMap: Record<string, string>
): string[] {
    const matched = new Set<string>();

    for (const file of changedFiles) {
        for (const [pattern, target] of Object.entries(contextMap)) {
            if (matchesPattern(file, pattern.trim())) {
                matched.add(target.trim());
            }
        }
    }

    if (matched.size === 0) {
        return ['project.md', 'changelog.md'];
    }

    return Array.from(matched);
}