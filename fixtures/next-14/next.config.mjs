// next.config.mjs: Next.js 14.2 reads no next.config.ts.
import { withInpBlame } from 'react-inp-blame/next';

// The tests run `next dev` beside `next start` of the build, so the dev server writes to a folder of its own.
export default withInpBlame({ distDir: process.env.NEXT_DIST_DIR || '.next' }, { enabled: true, runtime: { debugGlobal: true } });
