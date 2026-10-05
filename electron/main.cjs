// Desktop shell: the game is a browser build, so Electron serves it over the same
// zero-dependency static server instead of file:// (ES module imports need an origin).
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { startServer } = require('../server.cjs');

async function createWindow() {
  const server = await startServer({ port: 0 });
  const { port } = server.address();
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 840,
    minHeight: 620,
    // 与 --c-paper / <meta theme-color> / manifest 的 theme_color+background_color 同值：
    // 建窗到页面首帧之间露出的就是这个数，它和页面底色不一致时，启动会闪一块不同的黑，
    // 窗口被拉到非整数倍尺寸时边缘也会漏出第二种颜色。下面这条由 test/pwa.test.mjs 逐字对。
    backgroundColor: '#12100e',
    title: '割金 Euclid',
    // Windows/Linux take the window icon from here (macOS reads it from the app bundle). Without
    // it the desktop build ships wearing Electron's own logo instead of this game's.
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  win.on('closed', () => server.close());
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
