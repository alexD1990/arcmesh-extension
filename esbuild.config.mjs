import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production';

const base = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  external: ['vscode'],
  platform: 'node',
  target: 'node18',
  logLevel: 'info',
};

if (watch) {
  const extCtx = await esbuild.context({
    ...base,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    format: 'cjs',
  });
  const mcpCtx = await esbuild.context({
    ...base,
    entryPoints: ['src/mcpServer.ts'],
    outfile: 'out/mcpServer.js',
    format: 'esm',
  });
  await Promise.all([extCtx.watch(), mcpCtx.watch()]);
  console.log('[esbuild] watching...');
} else {
  await esbuild.build({
    ...base,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    format: 'cjs',
  });
  await esbuild.build({
    ...base,
    entryPoints: ['src/mcpServer.ts'],
    outfile: 'out/mcpServer.js',
    format: 'esm',
  });
}
