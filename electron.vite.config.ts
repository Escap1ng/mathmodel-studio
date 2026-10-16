import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// main / preload / renderer 三处都用 electron-vite 的默认目录约定：
// src/main/index.ts、src/preload/index.ts、src/renderer/index.html，产物落在 out/。
// 保持默认是为了让 Windows 首次 `npm run dev` 尽可能一次通过；要改目录时同步改 package.json 的 main。
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
