import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskListItem from "@tiptap/extension-task-item";
import { Bold, Heading2, List, Link2, Paperclip, AtSign, Code2, Loader2 } from "lucide-react";
import type { TaskAttachment, TaskItem } from "../../shared/taskTypes";
import type { TaskModeDocument } from "../../shared/taskModeTypes";
import { documentLink, taskLink } from "./taskModeView";

interface Props { value:string; onChange:(value:string)=>void; upload?:(files:File[])=>Promise<TaskAttachment[]>; tasks?:TaskItem[]; documents?:TaskModeDocument[]; label?:string; disabled?:boolean }
export function RichTaskEditor({value,onChange,upload,tasks=[],documents=[],label="任务描述",disabled=false}:Props) {
  const latest=useRef({onChange,upload});latest.current={onChange,upload};
  const fileInput=useRef<HTMLInputElement>(null);const [busy,setBusy]=useState(false),[error,setError]=useState(""),[picker,setPicker]=useState(false),[source,setSource]=useState(false);
  const editor=useEditor({extensions:[StarterKit.configure({link:{openOnClick:false}}),Image.configure({allowBase64:false}),Placeholder.configure({placeholder:"写下需求，输入 # 标题、列表；支持 Ctrl+V 粘贴图片和拖入附件…"}),Markdown,TableKit,TaskList,TaskListItem],content:value,contentType:"markdown",editable:!disabled,onUpdate:({editor})=>latest.current.onChange(editor.getMarkdown()),editorProps:{attributes:{"aria-label":label,role:"textbox","aria-multiline":"true"},handlePaste:(_view,event)=>{const files=Array.from(event.clipboardData?.files??[]);if(files.length&&latest.current.upload){void attach(files);return true;}return false;},handleDrop:(_view,event)=>{const files=Array.from(event.dataTransfer?.files??[]);if(files.length&&latest.current.upload){event.preventDefault();void attach(files);return true;}return false;}}});
  useEffect(()=>{if(editor&&editor.getMarkdown()!==value)editor.commands.setContent(value,{contentType:"markdown",emitUpdate:false});},[value,editor]);
  useEffect(()=>{editor?.setEditable(!disabled&&!busy);},[editor,disabled,busy]);
  async function attach(files:File[]) {if(!latest.current.upload||!files.length||busy)return;setBusy(true);setError("");try{const attachments=await latest.current.upload(files);if(editor&&!editor.isDestroyed){for(const attachment of attachments){if(attachment.mimeType.startsWith("image/"))editor.chain().focus().setImage({src:attachment.url,alt:attachment.name}).run();else editor.commands.insertContent(`\n[${attachment.name.replace(/[\[\]]/g,"")}](${attachment.url})\n`,{contentType:"markdown"});}latest.current.onChange(editor.getMarkdown());}}catch(error){setError(error instanceof Error?error.message:"附件上传失败");}finally{setBusy(false);}}
  function insertReference(title:string,url:string){editor?.commands.insertContent(`[${title.replace(/[\[\]]/g,"")}](${url}) `,{contentType:"markdown"});setPicker(false);}
  return <div className="tp-editor-shell"><div className="tp-editor-tools">
    <button type="button" className="tp-button tp-ghost" disabled={disabled||source} aria-label="标题" onClick={()=>editor?.chain().focus().toggleHeading({level:2}).run()}><Heading2/></button>
    <button type="button" className="tp-button tp-ghost" disabled={disabled||source} aria-label="加粗" onClick={()=>editor?.chain().focus().toggleBold().run()}><Bold/></button>
    <button type="button" className="tp-button tp-ghost" disabled={disabled||source} aria-label="列表" onClick={()=>editor?.chain().focus().toggleBulletList().run()}><List/></button>
    <button type="button" className="tp-button tp-ghost" disabled={disabled||source} onClick={()=>{const url=window.prompt("链接地址（https://…）");if(url&&/^https?:\/\//i.test(url)){const selected=editor?.state.doc.textBetween(editor.state.selection.from,editor.state.selection.to," ");if(selected)editor?.chain().focus().setLink({href:url}).run();else insertReference(url,url);}}}><Link2/>链接</button>
    <button type="button" className="tp-button tp-ghost" disabled={disabled||source} onClick={()=>setPicker(!picker)}><AtSign/>引用</button>
    {upload&&<button type="button" className="tp-button tp-ghost" disabled={disabled||busy||source} onClick={()=>fileInput.current?.click()}>{busy?<Loader2/>:<Paperclip/>}附件</button>}
    <button type="button" className="tp-button tp-ghost" style={{marginLeft:"auto"}} onClick={()=>setSource(!source)}><Code2/>{source?"返回编辑":"Markdown"}</button>
    <input ref={fileInput} type="file" multiple hidden onChange={event=>{void attach(Array.from(event.target.files??[]));event.target.value="";}}/>
  </div>{picker&&<div className="tm-reference-picker"><strong>引用任务或文档</strong>{tasks.map(task=><button type="button" key={task.id} onClick={()=>insertReference(`${task.key} ${task.title}`,taskLink(task.id))}>{task.key} · {task.title}</button>)}{documents.map(doc=><button type="button" key={doc.id} onClick={()=>insertReference(doc.title,documentLink(doc.id))}>文档 · {doc.title}</button>)}{!tasks.length&&!documents.length&&<span>还没有可引用的任务或文档。</span>}</div>}
  {source?<textarea className="tp-textarea tm-source" aria-label={`${label} Markdown`} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}/>:<EditorContent editor={editor} className="tp-rich tp-editor-content"/>}
  {busy&&<p className="tm-upload-state" role="status">正在上传附件，请稍候…</p>}{error&&<p className="tm-error" role="alert">{error}</p>}
  </div>;
}
