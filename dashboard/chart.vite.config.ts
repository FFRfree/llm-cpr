import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// CPRChart 壳：Recharts + React 打成单个 IIFE，产出 ../static/assets/cpr-chart.js + cpr-chart.css。
// CSS 单独吐出由页面 <link> 引（vanilla 页不引 Tailwind）。
export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': {} },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: '../static/assets',
    emptyOutDir: false,
    rollupOptions: { output: { assetFileNames: 'cpr-chart.[ext]' } },
    lib: {
      entry: new URL('./src/chart-global.tsx', import.meta.url).pathname,
      name: 'CPRChart',
      formats: ['iife'],
      fileName: () => 'cpr-chart.js',
    },
  },
});
