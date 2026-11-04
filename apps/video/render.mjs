// Renders the phone demo into ../site/public/media/: a WebM (VP9 with alpha), an opaque H.264 MP4 that WebKit
// falls back to, and a poster PNG; on macOS also the HEVC-with-alpha MOV that Safari and iOS play. Run on a
// machine with Node 22+ and
// Chrome (set CHROME_BIN to use a Chrome that is already installed). `npm run render:video` at the repo
// root calls this.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'site', 'public', 'media');
mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME_BIN ? [`--browser-executable=${process.env.CHROME_BIN}`] : [];
const remotion = (args) => execFileSync('npx', ['remotion', ...args, ...chrome], { cwd: here, stdio: 'inherit' });

remotion(['render', 'src/index.ts', 'PhoneDemo', join(out, 'phone-demo.webm'), '--codec=vp9', '--image-format=png', '--pixel-format=yuva420p', '--crf=34']);
remotion(['still', 'src/index.ts', 'PhoneDemo', join(out, 'phone-demo-poster.png'), '--frame=215', '--image-format=png', '--props={"showFinger":false}']);

// Safari and every iOS browser ignore the alpha in WebM, so main.js gives WebKit phone-demo.mov: the same video as
// HEVC with alpha. Only Apple's encoder writes that in a form WebKit plays, so it is made on macOS (ffmpeg from
// Homebrew, hevc_videotoolbox) from a ProRes 4444 master with alpha. Elsewhere this step is skipped and the
// committed phone-demo.mov stays as it is.
if (process.platform === 'darwin') {
  const master = join(here, 'phone-demo-master.mov');
  remotion(['render', 'src/index.ts', 'PhoneDemo', master, '--codec=prores', '--prores-profile=4444', '--pixel-format=yuva444p10le', '--image-format=png']);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', master, '-an', '-c:v', 'hevc_videotoolbox', '-alpha_quality', '0.75', '-b:v', '900k', '-tag:v', 'hvc1', '-movflags', '+faststart', join(out, 'phone-demo.mov')], { stdio: 'inherit' });
  rmSync(master);
}

// WebKit's fallback, where the MOV can't play: an opaque H.264 render of the same composition. main.js clips it to
// the phone body with a rounded clip-path (BODY x6 y6 r108 on the 720x1500 frame), so only the side buttons are lost.
remotion(['render', 'src/index.ts', 'PhoneDemo', join(out, 'phone-demo-webkit.mp4'), '--codec=h264', '--crf=22']);

for (const f of ['phone-demo.webm', 'phone-demo-poster.png', 'phone-demo.mov', 'phone-demo-webkit.mp4']) {
  try {
    console.log(f, statSync(join(out, f)).size, 'bytes');
  } catch {
    console.log(f, 'not written');
  }
}
