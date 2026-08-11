import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const markdownSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "blob"]
  }
};

export function MarkdownContent({ source, emptyText = "还没有补充说明。" }: { source: string; emptyText?: string }) {
  if (!source.trim()) {
    return <p className="task-markdown-empty">{emptyText}</p>;
  }
  return (
    <div className="task-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, markdownSchema]]}
        components={{
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          )
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
