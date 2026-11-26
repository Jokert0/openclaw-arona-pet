import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const view = fileURLToPath(new URL('.', import.meta.url));
const framework = process.env.CUBISM_FRAMEWORK || path.join(view, '.deps/framework');
await build({
  absWorkingDir: view,
  entryPoints: ['model.js'],
  alias: { cubism: path.resolve(framework, 'src') },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'AronaLive2D',
  target: 'es2022',
  minify: true,
  banner: { js: '/*! Includes Cubism Web Framework 5-r.4. Copyright Live2D Inc. See CubismFramework-LICENSE.md. */' },
  outfile: 'cubism.bundle.js',
});
