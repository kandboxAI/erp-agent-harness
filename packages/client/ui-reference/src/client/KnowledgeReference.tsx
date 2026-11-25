/** Knowledge reference presentation in the shared user-text pipeline. */
import type { UserTextNodeProps, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    knowledge: { readonly label: string }
  }
}

/** Recognize a complete knowledge-base wire reference before generic file matching. */
export const knowledgeReferenceRule: UserTextRule<'knowledge'> = {
  id: 'knowledge', order: 20,
  match(text, from) {
    const pattern = /@\[((?:\\.|[^\]\\\n])+)\]\(knowledge-base:[0-9a-f-]{36}\)/gu
    pattern.lastIndex = from
    const match = pattern.exec(text)
    return match === null ? undefined : {
      id: 'knowledge', start: match.index, end: match.index + match[0].length,
      data: { label: (match[1] as string).replace(/\\([\\\]])/gu, '$1') },
    }
  },
}

/** Render the user-facing name without exposing its internal reference identifier. */
export function KnowledgeReference({ node }: UserTextNodeProps<'knowledge'>) {
  return <ReferenceChip appearance="knowledge" label={node.data.label} title={node.data.label} />
}
