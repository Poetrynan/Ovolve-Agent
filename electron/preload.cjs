/**
 * preload.cjs — Electron 预加载脚本
 * 
 * 通过 contextBridge 安全地将 IPC API 暴露给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

// 暴露 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  getConfig: () => ipcRenderer.invoke('get_config'),
  setConfig: (config) => ipcRenderer.invoke('set_config', config),
  
  // Token
  getApiToken: () => ipcRenderer.invoke('get_api_token'),
  
  // 文件系统
  openFile: (filePath) => ipcRenderer.invoke('open_file', filePath),
  saveFile: (filePath, content) => ipcRenderer.invoke('save_file', filePath, content),
  listFiles: (dirPath) => ipcRenderer.invoke('list_files', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read_file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write_file', filePath, content),
  deleteFile: (filePath) => ipcRenderer.invoke('delete_file', filePath),
  
  // 应用信息
  getAppVersion: () => ipcRenderer.invoke('get_app_version'),
  getDataDir: () => ipcRenderer.invoke('get_data_dir'),
  
  // UI
  showNotification: (options) => ipcRenderer.invoke('show_notification', options),
  showMessageDialog: (options) => ipcRenderer.invoke('show_message_dialog', options),
  
  // 平台信息
  platform: typeof process !== 'undefined' && process.platform ? process.platform : 'win32',
});
