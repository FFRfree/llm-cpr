import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 看板前端构建：产物 = ../static/dashboard.html（单文件自包含，管理口静态分发零改动）。
// 依赖全在仓库根 package.json 的 devDependencies——npm 包保持「纯下载器」形态，用户侧零安装。
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: '../static',
    emptyOutDir: false,
    rollupOptions: { input: new URL('./dashboard.html', import.meta.url).pathname },
  },
});
