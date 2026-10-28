export type Passage = { id: string; text: string; start: number; end: number }

// Offsets are JavaScript UTF-16 offsets into the unchanged original, not edited
// posts. IDs are local to the thread/source revision captured by the context.
export function splitSource(text: string): Passage[] {
  const passages: Passage[] = []
  const separator = /\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g
  let start = 0
  const append = (end: number) => {
    if (text.slice(start, end).trim()) passages.push({ id: `p${start}-${end}`, text: text.slice(start, end), start, end })
  }
  for (const match of text.matchAll(separator)) {
    append(match.index)
    start = match.index + match[0].length
  }
  append(text.length)
  return passages
}
