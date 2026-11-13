import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const pages = [
  { path: '/', sources: ['apps/site/index.html', 'apps/site/src', 'apps/site/public', 'apps/site/vite.config.js'] },
  { path: '/demo/', sources: ['apps/demo/index.html', 'apps/demo/src', 'apps/demo/public', 'apps/demo/vite.config.ts', 'packages/core/src'] },
  { path: '/demo/devtools-hook', sources: ['apps/demo/devtools-hook.html', 'apps/demo/src/devtools-hook.tsx', 'apps/demo/src/scenarios/CascadingEffect.tsx', 'apps/demo/src/styles.css', 'apps/demo/public', 'apps/demo/vite.config.ts', 'packages/core/src'] },
];

const metadata = {
  name: 'site-metadata',
  generateBundle() {
    const urls = pages.map(({ path, sources }) => {
      const lastmod = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...sources], { cwd: repository, encoding: 'utf8' }).trim();
      if (!lastmod) throw new Error(`No source commit date found for ${path}`);
      return `  <url><loc>https://reactinpblame.com${path}</loc><lastmod>${lastmod}</lastmod></url>`;
    });
    this.emitFile({
      type: 'asset',
      fileName: 'sitemap.xml',
      source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    });
  },
  writeBundle({ dir }) {
    // Keep the existing appearance for missing URLs, with a static error document instead of the SPA fallback.
    const home = readFileSync(join(dir, 'index.html'), 'utf8');
    writeFileSync(join(dir, '404.html'), home.replace('</head>', '<meta name="robots" content="noindex">\n</head>'));
  },
};

// The landing page: plain HTML, one stylesheet and one small script, served at the domain root.
// `npm run build:site` builds it to apps/site/dist. `npm run build:demo` then builds the interactive demo
// into apps/site/dist/demo, so the demo is served at /demo/.
export default {
  base: '/',
  plugins: [metadata],
  publicDir: 'public',
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
};
