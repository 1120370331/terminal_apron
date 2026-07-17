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
