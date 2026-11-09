import upstream from './vite.config.mts';

export default async function actualBench(environment) {
  const config = await upstream(environment);
  const variant = process.env.BENCH_CONFIG;
  if (!['', 'b', 'c'].includes(variant ?? '')) throw new Error('Unknown Actual variant');
  // A never loads the library, including its build plugin.
  if (variant) {
    const { inpBlame } = await import('react-inp-blame/vite');
    config.plugins = [inpBlame({ enabled: true, runtime: { debugGlobal: true, overlay: variant === 'c' } }), ...config.plugins];
  }
  return config;
}
