import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DirectoryBrowserResult,
  FilesystemDirectory,
  FilesystemLocation,
  FilesystemLocationKind
} from "../shared/types.js";

const directoryCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base"
});

function directoryExists(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function addLocation(
  locations: FilesystemLocation[],
  seen: Set<string>,
  label: string,
  value: string,
  kind: FilesystemLocationKind
): void {
  if (!directoryExists(value)) {
    return;
  }
  const normalized = path.resolve(value);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  locations.push({ label, path: normalized, kind });
}

function filesystemLocations(): FilesystemLocation[] {
  const home = os.homedir();
  const locations: FilesystemLocation[] = [];
  const seen = new Set<string>();

  addLocation(locations, seen, "用户目录", home, "home");
  addLocation(locations, seen, "桌面", path.join(home, "Desktop"), "desktop");
  addLocation(locations, seen, "文档", path.join(home, "Documents"), "documents");
  addLocation(locations, seen, "下载", path.join(home, "Downloads"), "downloads");

  if (process.platform === "win32") {
    const driveRoots = [
      path.parse(home).root,
      path.parse(process.cwd()).root,
      process.env.SystemDrive ? `${process.env.SystemDrive}\\` : ""
    ];
    driveRoots.forEach((drive) => {
      if (drive) {
        addLocation(locations, seen, drive.slice(0, 2), drive, "drive");
      }
    });
  } else {
    addLocation(locations, seen, "根目录", path.parse(home).root, "drive");
  }

  return locations;
}

async function isDirectoryEntry(parentPath: string, name: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(path.join(parentPath, name))).isDirectory();
  } catch {
    return false;
  }
}

export async function browseFilesystemDirectory(requestedPath?: string): Promise<DirectoryBrowserResult> {
  const targetPath = path.resolve(requestedPath?.trim() || os.homedir());
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(targetPath);
  } catch {
    throw new Error("目录不存在或无法访问");
  }
  if (!stat.isDirectory()) {
    throw new Error("所选路径不是文件夹");
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
  } catch {
    throw new Error("没有权限读取此目录");
  }

  const directoryFlags = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? Promise.resolve(true)
        : entry.isSymbolicLink()
          ? isDirectoryEntry(targetPath, entry.name)
          : Promise.resolve(false)
    )
  );
  const directories: FilesystemDirectory[] = entries
    .filter((_entry, index) => directoryFlags[index])
    .map((entry) => ({
      name: entry.name,
      path: path.join(targetPath, entry.name)
    }))
    .sort((left, right) => directoryCollator.compare(left.name, right.name));

  const root = path.parse(targetPath).root;
  return {
    path: targetPath,
    parentPath: targetPath === root ? null : path.dirname(targetPath),
    locations: filesystemLocations(),
    directories
  };
}
