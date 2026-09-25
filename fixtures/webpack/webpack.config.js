import path from 'node:path'
import HtmlWebpackPlugin from 'html-webpack-plugin'

export default (_env, argv) => ({
  entry: './src/index.tsx',
  output: {
    path: path.resolve(import.meta.dirname, 'dist'),
    filename: '[name].[contenthash].js',
    clean: true,
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  module: {
    rules: [
      // The names loader, as the README gives it.
      { test: /\.[jt]sx$/, exclude: /node_modules/, enforce: 'pre', use: ['react-inp-blame/display-names-loader'] },
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', { targets: 'defaults' }],
              ['@babel/preset-react', { runtime: 'automatic', development: argv.mode === 'development' }],
              '@babel/preset-typescript',
            ],
          },
        },
      },
    ],
  },
  optimization: {
    // Every dependency in one chunk, react-dom and react-inp-blame together, which the page loads before
    // the entry's own.
    splitChunks: {
      chunks: 'all',
      cacheGroups: { vendor: { test: /[\\/]node_modules[\\/]/, name: 'vendor', chunks: 'all' } },
    },
  },
  plugins: [new HtmlWebpackPlugin({ template: './index.html' })],
  devtool: argv.mode === 'production' ? 'source-map' : 'cheap-module-source-map',
  devServer: { client: { overlay: false } },
})
