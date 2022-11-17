# Wingmate SQL tools

Recognizes SQL within code strings using [tree-sitter](https://tree-sitter.github.io/tree-sitter/) and does syntax highlighting and syntax error detection:

![](./images/screenshot.png)

![](./images/completions.png)

Free for non-commercial use.

You need a [subscription](https://buy.stripe.com/fZeaEG6em0Bx6LmbII) for commercial use.

## Configuration

gopls's semantic highlighting prevents SQL syntax highlighting from working. You can disable it with this setting:

```json
{
  "gopls.ui.semanticTokens": false
}
```

Some themes don't support semantic highlighting and you need to force it:

```json
{
  "editor.semanticTokenColorCustomizations": {
    "[Gatito Theme]": {
      "enabled": true
    }
  }
}
```

To get autocomplete in strings, you need to enable it:

```json
{
  "editor.quickSuggestions.strings": true
}
```

To get column name completions, set your database connection:

```json
{
  "wingmate.conn": "postgresql://localhost:5432/postgres"
}
```

You can add custom SQL prefixes (or hints) to the parser if your DB methods aren't in the default list:

```json
{
  "wingmate.prefixes": ["Exec(", "Prepare(", "Query(", "/*SQL*/ "]
}
```

## Related

- [Inline SQL](https://marketplace.visualstudio.com/items?itemName=qufiwefefwoyn.inline-sql-syntax) supports more languages and performs linting, but doesn't recognize syntax as well and I couldn't get linting to work
- [Highlight String Code](https://marketplace.visualstudio.com/items?itemName=iuyoy.highlight-string-code) supports more langauges and a few other features
- [python-string-sql](https://marketplace.visualstudio.com/items?itemName=ptweir.python-string-sql) for Python
- [SQL tagged template literals](https://marketplace.visualstudio.com/items?itemName=frigus02.vscode-sql-tagged-template-literals) for JS/TS
- [vscode-sql-template-literal](https://marketplace.visualstudio.com/items?itemName=forbeslindesay.vscode-sql-template-literal) for JS/TS
