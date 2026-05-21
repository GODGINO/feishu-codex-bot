import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';
import * as path from 'path';

let tray: Tray | null = null;
let trayWindow: BrowserWindow | null = null;

export function createTray(window: BrowserWindow): void {
  trayWindow = window;

  const iconPath = path.join(__dirname, '..', '..', 'assets', 'iconTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  // Mark as template so macOS handles dark/light mode automatically
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Sigma Terminal');

  tray.on('click', (_event, bounds) => {
    if (!trayWindow) return;

    if (trayWindow.isVisible()) {
      trayWindow.hide();
      return;
    }

    const { width, height } = trayWindow.getBounds();

    let xPos: number;
    let yPos: number;

    if (process.platform === 'darwin') {
      // macOS: tray is at top, popup drops down below icon
      xPos = Math.round(bounds.x - width / 2);
      yPos = Math.round(bounds.y);
    } else {
      // Windows/Linux: tray is at bottom, popup extends upward from taskbar
      xPos = Math.round(bounds.x - width / 2);
      yPos = Math.round(bounds.y - height);
    }

    // Clamp to screen bounds
    const { screen } = require('electron');
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const workArea = display.workArea;
    xPos = Math.max(workArea.x, Math.min(xPos, workArea.x + workArea.width - width));
    yPos = Math.max(workArea.y, Math.min(yPos, workArea.y + workArea.height - height));

    trayWindow.setBounds({ x: xPos, y: yPos, width, height });
    trayWindow.show();
    trayWindow.focus();
  });

  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show',
        click: () => {
          trayWindow?.show();
          trayWindow?.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Sigma Terminal',
        click: () => {
          trayWindow?.destroy();
          app.quit();
        },
      },
    ]);
    tray?.popUpContextMenu(contextMenu);
  });
}

export function updateTrayIcon(connected: boolean, controlling = false): void {
  if (!tray) return;
  // Use tooltip to indicate status (icon stays as template for menubar consistency)
  if (controlling) {
    tray.setToolTip('Sigma Terminal — Controlling (press ESC to stop)');
  } else {
    tray.setToolTip(connected ? 'Sigma Terminal — Connected' : 'Sigma Terminal — Disconnected');
  }
}
