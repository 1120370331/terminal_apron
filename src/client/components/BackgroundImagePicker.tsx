import { ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../api";

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
}

export function BackgroundImagePicker({ value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectFile = async (file: File | undefined) => {
    if (!file || busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const uploaded = await api.uploadBackground(file);
      onChange(uploaded.url);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setBusy(false);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  };

  return (
    <div className="background-image-picker">
      <div
        className={value ? "background-image-preview has-image" : "background-image-preview"}
        style={value ? { backgroundImage: `url("${value}")` } : undefined}
      >
        {!value && <span>未选择背景图</span>}
      </div>
      <div className="background-image-actions">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          hidden
          onChange={(event) => void selectFile(event.target.files?.[0])}
        />
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus size={16} />
          {busy ? "上传中..." : value ? "更换图片" : "选择图片"}
        </button>
        {value && (
          <button className="icon-button" type="button" title="清除背景图" onClick={() => onChange(null)}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
      {error && <div className="form-error background-image-error">{error}</div>}
    </div>
  );
}
