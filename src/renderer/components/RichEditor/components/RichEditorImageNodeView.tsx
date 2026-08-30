import { resolveFileResourceUrl } from '@renderer/utils/filePreview'
import { type NodeViewProps, NodeViewWrapper } from '@tiptap/react'

export default function RichEditorImageNodeView({ node }: NodeViewProps) {
  const { alt, height, src, title, width } = node.attrs

  return (
    <NodeViewWrapper>
      <img
        alt={typeof alt === 'string' ? alt : undefined}
        className="rich-editor-image"
        height={typeof height === 'number' || typeof height === 'string' ? height : undefined}
        src={typeof src === 'string' ? resolveFileResourceUrl(src) : undefined}
        title={typeof title === 'string' ? title : undefined}
        width={typeof width === 'number' || typeof width === 'string' ? width : undefined}
      />
    </NodeViewWrapper>
  )
}
