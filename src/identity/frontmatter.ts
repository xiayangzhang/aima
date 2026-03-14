export interface ParsedFrontmatter {
  body: string
  allowedTools: string[]
}

/**
 * Parse YAML frontmatter from Markdown content.
 * - frontmatter must start with "---\n" on the first line
 * - ends at the next "---\n" or "---" at end of file
 * - only extracts allowed_tools field; other fields are ignored
 * - on parse failure, logs console.warn and returns body=original, allowedTools=[]
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  try {
    const match = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/.exec(content)

    if (!match || match[1] === undefined) {
      return { body: content.trim(), allowedTools: [] }
    }

    const frontmatterBlock = match[1]
    const body = content.slice(match[0].length).trim()

    const allowedTools = extractAllowedTools(frontmatterBlock)
    return { body, allowedTools }
  } catch (err) {
    console.warn('Failed to parse frontmatter:', err)
    return { body: content.trim(), allowedTools: [] }
  }
}

function extractAllowedTools(block: string): string[] {
  // Find the allowed_tools field
  const fieldMatch = /^allowed_tools\s*:(.*)/m.exec(block)
  if (!fieldMatch || fieldMatch[1] === undefined) return []

  const afterColon = fieldMatch[1].trim()

  // Single-line array format: [bash, edit]
  if (afterColon.startsWith('[')) {
    const bracketMatch = /\[([^\]]*)\]/.exec(afterColon)
    if (!bracketMatch || bracketMatch[1] === undefined || bracketMatch[1].trim() === '') return []
    return bracketMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }

  // Multi-line list format: find "- item" entries after allowed_tools:
  // Get the block starting from after "allowed_tools:"
  const fieldStart = block.indexOf(fieldMatch[0]) + fieldMatch[0].length
  const rest = block.slice(fieldStart)

  // Collect lines that are list items until we hit a non-indented key or end
  const items: string[] = []
  for (const line of rest.split('\n')) {
    const itemMatch = /^\s+-\s+(.+)$/.exec(line)
    if (itemMatch && itemMatch[1] !== undefined) {
      const value = itemMatch[1].trim().replace(/^['"]|['"]$/g, '')
      if (value) items.push(value)
    } else if (/^\S/.test(line) && line.trim() !== '') {
      // Non-indented line = new key, stop
      break
    }
  }

  return items
}
