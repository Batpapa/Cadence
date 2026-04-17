const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CopyPlugin = require('copy-webpack-plugin');

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
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
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
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({ template: './src/index.html' }),
      ...(!isDev ? [new MiniCssExtractPlugin({ filename: 'styles.[contenthash].css' })] : []),
      ...(!isDev ? [new CopyPlugin({
        patterns: [
          { from: 'src/icons',         to: 'icons' },
          { from: 'src/manifest.json', to: 'manifest.json' },
          { from: 'src/sw.js',         to: 'sw.js' },
        ],
      })] : []),
    ],
    devServer: {
      port: 3002,
      hot: true,
    },
    devtool: isDev ? 'eval-source-map' : false,
  };
};
