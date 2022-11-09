from pathlib import Path
import re

text = Path("tree-sitter-sql/grammar.js").read_text()

chunks = []
chunks.append('export const KEYWORDS = [\n')
for m in re.finditer(r'kw\("([\w ]+)"\)', text):
  chunks.append("  '" + m.group(1) + "',\n")
chunks.append(']\n')

Path("src/sql.ts").write_text(''.join(chunks))
