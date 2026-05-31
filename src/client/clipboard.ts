export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (selection) {
    selection.removeAllRanges();
    for (const range of ranges) {
      selection.addRange(range);
    }
  }
  activeElement?.focus();

  if (!copied) {
    throw new Error("Clipboard copy failed");
  }
}

export async function readClipboardText(): Promise<string> {
  if (!navigator.clipboard?.readText || !window.isSecureContext) {
    return "";
  }
  return navigator.clipboard.readText();
}

export async function readClipboardFiles(): Promise<File[]> {
  if (!navigator.clipboard?.read || !window.isSecureContext) {
    return [];
  }

  const files: File[] = [];
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const fileTypes = item.types.filter(isClipboardFileType);
    for (const type of fileTypes) {
      const blob = await item.getType(type);
      files.push(
        new File([blob], clipboardFileName(type, files.length), {
          type,
          lastModified: Date.now()
        })
      );
    }
  }

  return dedupeFiles(files);
}

export function filesFromClipboardData(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) {
    return [];
  }

  const files: File[] = [];
  const addFile = (file: File | null) => {
    if (file) {
      files.push(file);
    }
  };

  for (const file of Array.from(clipboardData.files)) {
    addFile(file);
  }

  for (const item of Array.from(clipboardData.items)) {
    if (item.kind === "file") {
      addFile(item.getAsFile());
    }
  }

  return dedupeFiles(files);
}

function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const unique: File[] = [];
  for (const file of files) {
    const key = [file.name, file.type, file.size, file.lastModified].join("\u001f");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(file);
  }
  return unique;
}

function isClipboardFileType(type: string): boolean {
  return type.startsWith("image/") || type === "application/pdf";
}

function clipboardFileName(mimeType: string, index: number): string {
  return `clipboard-${index + 1}${extensionForMimeType(mimeType)}`;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/jpeg") {
    return ".jpg";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "application/pdf") {
    return ".pdf";
  }
  return ".bin";
}
