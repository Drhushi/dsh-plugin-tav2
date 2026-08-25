// 构建浏览器端 client bundle（lazy-CJS 包装，供 dsh client-modules 加载）：
//   node scripts/build-client.mjs
// 产物 dist/client.js 带 window.__ModuleLoader__.load({ id, factory }) 包装；
// react 等平台模块走外部（运行时的 loader module table 提供 require），
// 其余依赖全部内联（本 bundle 实际只依赖 react）。
import { build } from 'esbuild'

// 与 deepseek-harness packages/client/web/src/platform.ts 的 PLATFORM_MODULES
// 保持一致 + runtime 的 RUNTIME_STORE_EXEMPTION（本项目只用 react，其余列出
// 以免未来引入平台模块时被错误内联）。
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const PLUGIN_ID = 'dsh-plugin-tav2'

await build({
  entryPoints: ['src/client/index.js'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: PLATFORM_MODULES,
  sourcemap: true,
  minify: false,
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

console.log('[build-client] dist/client.js 构建完成（lazy-CJS，外部模块：react 等平台模块）')
