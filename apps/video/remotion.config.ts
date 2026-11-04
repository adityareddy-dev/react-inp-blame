import { Config } from '@remotion/cli/config';

// Transparent output: PNG frames with an alpha channel, so only the phone is opaque.
Config.setVideoImageFormat('png');
Config.setOverwriteOutput(true);

// The library's source imports its own files with a .js ending, as TypeScript's NodeNext rules want.
// The bundler is told that ./x.js can be ./x.ts, so the video imports the real badge and panel as they are.
Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
}));
