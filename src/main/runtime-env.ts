import { app } from 'electron'
import { join } from 'node:path'

// 开发时资源在仓库根；打包后 runtime/skills/schemas/python 放在 resources/ 下——
// app.asar 里的文件 Python 读不到，所以 ROOT 必须指向 resourcesPath 而不是 __dirname 往上找。
export const APP_ROOT =
  process.env['MMS_HOME'] || (app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..'))

export function runtimePython(): string {
  const override = process.env['MMS_PYTHON']
  if (override) return override
  if (!app.isPackaged) return process.platform === 'win32' ? 'python' : 'python3'
  return process.platform === 'win32'
    ? join(APP_ROOT, 'python', 'python.exe')
    : join(APP_ROOT, 'python', 'bin', 'python3')
}
