const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CopyPlugin = require('copy-webpack-plugin');

const TEMPLATE = './src/index.html';

const CSP_PLACEHOLDER = '%CSP%';

/**
 * CSP hashes for every inline script in the FINAL html.
 *
 * The theme bootstrap has to run before the first paint (it paints the
 * background so a light-theme user does not get a dark flash), so it cannot
 * move into the bundle, and an inline script needs an explicit hash once
 * 'unsafe-inline' is gone.
 *
 * Hashing the emitted markup rather than the template is not a detail: in
 * production html-webpack-plugin minifies the document and strips the
 * whitespace around inline script bodies, so a hash taken from src/index.html
 * does not match what the browser ends up parsing — which would block the
 * script and leave every user on an unstyled flash. Measured, not assumed.
 *
 * The HTML parser also normalises CRLF to LF before the script text reaches the
 * DOM, so hash the LF form — otherwise this breaks on a Windows checkout only.
 */
function inlineScriptHashes(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n/g, '\n'), 'utf8').digest('base64')}'`);
}

/**
 * Deliberately narrow: no `default-src`, so connect/img/media/frame/font/style
 * stay exactly as permissive as they are today. This is a second line of
 * defence behind the sanitiser in markdown.ts, not a rewrite of the app's
 * network policy — and a wrong `connect-src` would break Drive sync or the
 * tune imports for real users, which is a far worse outcome than the narrower
 * policy. The three directives here are the ones that actually blunt an
 * injected payload:
 *   - script-src without 'unsafe-inline' kills inline event handlers
 *     (`<img src=x onerror=…>`, the realistic vector through imported notes);
 *   - object-src 'self' blob: kills <object>/<embed> payloads from anywhere
 *     else. Not 'none', which it was from 2026-09-06 to 14: the file viewer
 *     shows a PDF attachment in an <embed> fed by a blob: URL, and 'none'
 *     blocked every one of them — an empty frame, for every user, on every
 *     browser (confirmed in Chrome with this exact policy; field report from
 *     a user whose PDFs "mostly" stopped opening);
 *   - base-uri 'self' stops an injected <base> from redirecting every
 *     relative URL, including the bundle.
 *
 * `blob:` is required by the PCM AudioWorklet, which loads its processor from
 * an object URL (session/audio/pcmWorklet.ts). It is a real limit on what this
 * policy can promise — code that can already run could still execute a blob —
 * so the sanitiser, not this, is what closes the hole.
 *
 * 'wasm-unsafe-eval' is required by the FolkFriend and web-demuxer WASM
 * modules; without it the Sessions feature stops working entirely.
 *
 * 'unsafe-eval' is required too, and in production, not only for dev's
 * eval-source-map. web-demuxer runs its demuxer in a worker built from a blob
 * (base64 inside its bundle), and a blob worker inherits THIS policy; its
 * emscripten/embind glue builds its invokers with `new Function`. Without it
 * the demuxer dies on load, every file import silently falls back to decoding
 * the whole recording in one go, and a long one then fails for lack of memory.
 * That shipped for a week (2026-09-06 → 13) unnoticed: a grep of the bundles
 * for eval cannot see into the base64, short files still decode whole, and dev
 * — which always had 'unsafe-eval' — never showed it. What this gives up is
 * string-to-code sinks for code that is already running; the vector the policy
 * exists for, inline handlers, stays blocked. And dev is now genuinely the
 * same policy as production, which is the point: a CSP that only exists in
 * production is first tested by users.
 */
function contentSecurityPolicy(html) {
  const script = [
    "'self'",
    "'wasm-unsafe-eval'",
    'blob:',
    ...inlineScriptHashes(html),
    // Google Identity Services: the gsi/client script itself, plus the two
    // Google CDNs it is documented to pull from. Generous on purpose — a
    // blocked auth script means users silently lose Drive sync.
    'https://accounts.google.com',
    'https://apis.google.com',
    'https://www.gstatic.com',
    "'unsafe-eval'",
  ].join(' ');
  return [`script-src ${script}`, "object-src 'self' blob:", "base-uri 'self'"].join('; ');
}

/** Substitutes the real policy into index.html once the document is final —
 *  after html-webpack-plugin has injected the bundle tags and minified, which
 *  is the only point where the inline scripts can be hashed correctly. Throws
 *  rather than shipping the placeholder: a page whose CSP never got filled in
 *  is a page with no policy at all, and that should fail the build loudly. */
class CspPlugin {
  apply(compiler) {
    compiler.hooks.compilation.tap('CspPlugin', (compilation) => {
      HtmlWebpackPlugin.getHooks(compilation).beforeEmit.tapAsync('CspPlugin', (data, cb) => {
        if (!data.html.includes(CSP_PLACEHOLDER)) {
          cb(new Error(`index.html: ${CSP_PLACEHOLDER} not found — the Content-Security-Policy meta would ship empty`));
          return;
        }
        data.html = data.html.replace(CSP_PLACEHOLDER, contentSecurityPolicy(data.html));
        cb(null, data);
      });
    });
  }
}

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
      new HtmlWebpackPlugin({ template: TEMPLATE }),
      new CspPlugin(),
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
