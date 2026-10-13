/**
 * main.cjs — Electron 主进程
 * 
 * 负责：
 * - 创建应用窗口
 * - 管理应用生命周期
 * - 注册 IPC 命令
 * - 文件系统访问
 */

const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// 开发模式标志
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// 主窗口引用
let mainWindow = null;

/**
 * 创建主窗口
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    center: true,
    resizable: true,
    fullscreenable: false,
    title: 'OvolveAgent',
    icon: path.join(__dirname, 'icons', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    // macOS 风格
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    // Windows 风格
    autoHideMenuBar: true,
    backgroundColor: '#0B0F17',
  });

  // 失败自动重试（防止开发服务器启动延迟）
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log(`Page failed to load (${errorCode}: ${errorDescription}), retrying...`);
    if (isDev) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL('http://localhost:5173');
        }
      }, 1500);
    }
  });

  // 加载前端
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 窗口关闭处理
  mainWindow.on('close', (event) => {
    // 可以在这里添加保存状态逻辑
    console.log('Main window close requested');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 快捷键支持（F5 / Ctrl+R 刷新，F12 / Ctrl+Shift+I 开发者工具）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // F5 或 Ctrl+R / Cmd+R -> 刷新
    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r' && !input.shift)) {
      mainWindow.reload();
      event.preventDefault();
    }
    // Ctrl+Shift+R / Cmd+Shift+R -> 强制忽略缓存刷新
    else if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reloadIgnoringCache();
      event.preventDefault();
    }
    // F12 或 Ctrl+Shift+I / Cmd+Alt+I -> 切换开发者工具
    else if (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

// ── 应用生命周期 ──

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ── IPC 命令处理 ──

// 获取 API Token
ipcMain.handle('get_api_token', async () => {
  // 从安全存储获取
  return process.env.OMNIAGENT_API_TOKEN || null;
});

// 获取配置
ipcMain.handle('get_config', async () => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to read config:', e);
  }
  return null;
});

// 保存配置
ipcMain.handle('set_config', async (event, config) => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save config:', e);
    return false;
  }
});

// 打开文件
ipcMain.handle('open_file', async (event, filePath) => {
  try {
    await shell.openPath(filePath);
    return true;
  } catch (e) {
    console.error('Failed to open file:', e);
    return false;
  }
});

// 保存文件
ipcMain.handle('save_file', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save file:', e);
    return false;
  }
});

// 获取应用版本
ipcMain.handle('get_app_version', async () => {
  return app.getVersion();
});

// 获取数据目录
ipcMain.handle('get_data_dir', async () => {
  return app.getPath('userData');
});

// 列出文件
ipcMain.handle('list_files', async (event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  } catch (e) {
    console.error('Failed to list files:', e);
    return [];
  }
});

// 读取文件
ipcMain.handle('read_file', async (event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error('Failed to read file:', e);
    return null;
  }
});

// 写入文件
ipcMain.handle('write_file', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to write file:', e);
    return false;
  }
});

// 删除文件
ipcMain.handle('delete_file', async (event, filePath) => {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    console.error('Failed to delete file:', e);
    return false;
  }
});

// 显示通知
ipcMain.handle('show_notification', async (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
    return true;
  }
  return false;
});

// 显示消息对话框
ipcMain.handle('show_message_dialog', async (event, options) => {
  if (!mainWindow) return null;
  const result = await dialog.showMessageBox(mainWindow, options);
  return result;
});
