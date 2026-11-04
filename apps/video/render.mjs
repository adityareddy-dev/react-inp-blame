// Renders the phone demo into ../site/public/media/: a WebM (VP9 with alpha), an opaque H.264 MP4 for
// WebKit, and a poster PNG. Run on a machine with Node 22+ and
// Chrome (set CHROME_BIN to use a Chrome that is already installed). `npm run render:video` at the repo
// root calls this.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'site', 'public', 'media');
mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME_BIN ? [`--browser-executable=${process.env.CHROME_BIN}`] : [];
const remotion = (args) => execFileSync('npx', ['remotion', ...args, ...chrome], { cwd: here, stdio: 'inherit' });

remotion(['render', 'src/index.ts', 'PhoneDemo', join(out, 'phone-demo.webm'), '--codec=vp9', '--image-format=png', '--pixel-format=yuva420p', '--crf=34']);
remotion(['still', 'src/index.ts', 'PhoneDemo', join(out, 'phone-demo-poster.png'), '--frame=215', '--image-format=png', '--props={"showFinger":false}']);

// The WebKit file. Safari and every iOS browser ignore the alpha in WebM, and no ffmpeg available here can write
// HEVC with alpha, so WebKit gets an opaque H.264 render of the same composition. main.js clips it to the phone
// body with a rounded clip-path (BODY x6 y6 r108 on the 720x1500 frame), so only the side buttons are lost.
remotion(['render', 'src/index.ts', 'PhoneDemo', join(out, 'phone-demo-webkit.mp4'), '--codec=h264', '--crf=22']);

for (const f of ['phone-demo.webm', 'phone-demo-poster.png', 'phone-demo-webkit.mp4']) {
  try {
    console.log(f, statSync(join(out, f)).size, 'bytes');
  } catch {
    console.log(f, 'not written');
  }
}
