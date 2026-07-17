import { execFile } from "node:child_process";

const WINDOWS_DIRECTORY_PICKER = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "选择 Terminal 项目文件夹"
$dialog.ShowNewFolderButton = $true
$dialog.AutoUpgradeEnabled = $true
$initial = $env:TWM_DIRECTORY_PICKER_INITIAL
if ($initial -and [System.IO.Directory]::Exists($initial)) {
  $dialog.SelectedPath = [System.IO.Path]::GetFullPath($initial)
}
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
    exit 0
  }
  exit 2
} finally {
  $dialog.Dispose()
}
`.trim();

export function selectNativeDirectory(initialPath?: string): Promise<string | null> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("当前服务器系统不支持原生文件夹选择器"));
  }

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-STA", "-Command", WINDOWS_DIRECTORY_PICKER],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TWM_DIRECTORY_PICKER_INITIAL: initialPath?.trim() || ""
        },
        windowsHide: false
      },
      (error, stdout, stderr) => {
        if (error) {
          if (Number(error.code) === 2) {
            resolve(null);
            return;
          }
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        resolve(stdout.trim() || null);
      }
    );
  });
}
