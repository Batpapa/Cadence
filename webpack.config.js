const path = require('path');
const { execFile } = require('child_process');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CopyPlugin = require('copy-webpack-plugin');

// Runs ts-prune after compilation and injects unused-export lines as webpack errors.
// Skipped in dev mode (too slow for watch). Lines marked "(used in module)" are filtered
// out — they are type-only exports erased at compile time and rarely a real problem.
class TsPrunePlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tapAsync('TsPrunePlugin', (compilation, callback) => {
      // vendor/ is generated code (wasm-bindgen output) — not ours to prune.
      execFile(process.execPath, [require.resolve('ts-prune/lib/index.js'), '--ignore', 'vendor'], { cwd: __dirname }, (_err, stdout) => {
        const lines = stdout.trim().split('\n').filter(l => l && !l.includes('(used in module)'));
        for (const line of lines) {
          compilation.errors.push(new compilation.compiler.webpack.WebpackError(`[ts-prune] ${line.replace(/\\/g, '/')}`));
        }
        callback();
      });
    });
  }
}

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    name: 'cadence',
    entry: './src/main.ts',
    output: {
      path:       path.resolve(__dirname, 'dist'),
      filename:   isDev ? 'bundle.js' : 'bundle.[contenthash].js',
      clean:      true,
      publicPath: isDev ? undefined : '',
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: [
            isDev ? 'style-loader' : MiniCssExtractPlugin.loader,
            'css-loader',
            'postcss-loader',
          ],
        },
        {
          test: /\.(woff2?|ttf)$/,
          type: 'asset/resource',
          generator: { filename: 'fonts/[name].[hash:8][ext]' },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({ template: './src/index.html' }),
      ...(!isDev ? [new TsPrunePlugin()] : []),
      ...(!isDev ? [new MiniCssExtractPlugin({ filename: 'styles.[contenthash].css' })] : []),
      ...(!isDev ? [new CopyPlugin({
        patterns: [
          { from: 'src/icons',         to: 'icons' },
          { from: 'src/manifest.json', to: 'manifest.json' },
          { from: 'src/sw.js',         to: 'sw.js' },
          { from: 'src/privacy.html',  to: 'privacy.html' },
          { from: 'src/terms.html',    to: 'terms.html' },
          { from: 'src/robots.txt',    to: 'robots.txt' },
          { from: 'src/sitemap.xml',   to: 'sitemap.xml' },
          { from: 'src/googleadb03431aeef178b.html', to: 'googleadb03431aeef178b.html' },
        ],
      })] : []),
    ],
    devServer: {
      port: 3002,
      hot: true,
      // Mirrors the CopyPlugin patterns above (which only run in production) —
      // without this, static files like privacy.html/terms.html 404 in dev.
      static: { directory: path.resolve(__dirname, 'src') },
    },
    devtool: isDev ? 'eval-source-map' : false,
  };
};
