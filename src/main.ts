import { Observable, Subject, Subscription, tap, TeardownLogic } from 'rxjs'
import Parser, { SyntaxNode } from 'web-tree-sitter'
import * as vscode from 'vscode'
import fs from 'fs'
import path from 'path'
import * as I from 'immutable'

export async function activate(context: vscode.ExtensionContext) {
  activateAsync(context).catch(e => console.error(e))
}

export async function activateAsync(context: vscode.ExtensionContext) {
  const addDisposable = mkAddDisposable(context)

  const extensionPath = vscode.extensions.getExtension('chrismwendt.wingmate')?.extensionPath
  if (!extensionPath) throw new Error('❌ no extension path')

  await Parser.init()
  const goParser = new Parser()
  goParser.setLanguage(await Parser.Language.load(path.join(extensionPath, 'out/tree-sitter-go.wasm')))
  const sqlParser = new Parser()
  sqlParser.setLanguage(await Parser.Language.load(path.join(extensionPath, 'out/tree-sitter-sql.wasm')))

  const legend = new vscode.SemanticTokensLegend(Object.values(TokenType))
  const provider: vscode.DocumentSemanticTokensProvider = {
    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
      const tokensBuilder = new vscode.SemanticTokensBuilder(legend)

      walkSql(document, goParser, sqlParser, (sqlNode, range) => {
        const tokenType = nodeToTokenType(sqlNode)
        if (tokenType) {
          for (const lineRange of singleLineRanges(range)) tokensBuilder.push(lineRange, tokenType, [])
          return 'bail'
        }
      })

      return tokensBuilder.build()
    },
  }
  addDisposable(vscode.languages.registerDocumentSemanticTokensProvider({ language: 'go' }, provider, legend))

  const diagnostics = addDisposable(vscode.languages.createDiagnosticCollection('sql'))
  const diagnose = (document: vscode.TextDocument) => {
    const diags: vscode.Diagnostic[] = []
    walkSql(document, goParser, sqlParser, (sqlNode, range) => {
      if (sqlNode.type === 'ERROR') {
        const ancestry = ancestors(sqlNode)
          .map(ancestor => ancestor.type)
          .join('.')
        diags.push(new vscode.Diagnostic(range, `Syntax error in SQL at ${ancestry}`, vscode.DiagnosticSeverity.Error))
        return 'bail'
      }
    })

    diagnostics.set(document.uri, diags)
  }
  addDisposable(vscode.workspace.onDidChangeTextDocument(event => diagnose(event.document)))
  const editor = vscode.window.activeTextEditor
  if (editor) diagnose(editor.document)

  addDisposable(
    vscode.languages.registerHoverProvider(
      { language: 'go' },
      {
        provideHover: (document, position, cancellation): vscode.ProviderResult<vscode.Hover> => {
          const result = getSqlNodeAt(document, goParser, sqlParser, position)
          if (!result) return { contents: ['no sqlNode'] }
          const [stringStart, sqlNode] = result
          return {
            contents: [
              new vscode.MarkdownString(
                ancestors(sqlNode)
                  .map(ancestor => ancestor.type)
                  .join('.')
              ),
            ],
            range: new vscode.Range(
              document.positionAt(stringStart + sqlNode.startIndex),
              document.positionAt(stringStart + sqlNode.endIndex)
            ),
          }
        },
      }
    )
  )

  addDisposable(
    vscode.languages.registerCompletionItemProvider(
      { language: 'go' },
      {
        // Completion inside strings is disabled by default, need to enable it:
        // https://github.com/microsoft/vscode/issues/23962#issuecomment-292079416
        provideCompletionItems: (document, position, cancellation, context) => {
          const result = getSqlNodeAt(
            document,
            goParser,
            sqlParser,
            new vscode.Position(position.line, Math.max(0, position.character - 1))
          )
          if (!result) return
          const [, sqlNode] = result
          return [new vscode.CompletionItem(sqlNode.type)]
        },
      }
    )
  )
}

enum TokenType {
  keyword = 'sqlkeyword',
  string = 'sqlstring',
  number = 'sqlnumber',
  asterisk = 'sqlasterisk',
  comment = 'sqlcomment',
  identifier = 'sqlidentifier',
  operator = 'sqloperator',
  whitespace = 'sqlwhitespace',
}

const nodeToTokenType = (node: SyntaxNode): TokenType | undefined => {
  if (/^keyword/.test(node.type)) return TokenType.keyword
  else if (node.type === 'literal' && /^('|")/.test(node.text)) return TokenType.string
  else if (node.type === 'literal' && /^[0-9]/.test(node.text)) return TokenType.number
  else if (node.type === 'all_fields') return TokenType.asterisk
  else if (node.type === 'comment') return TokenType.comment
  else if (node.type === 'identifier') return TokenType.identifier
  else if (/^[`~!@#$%^&*()\-_=+\\|/?,<.>;:]+$/.test(node.type)) return TokenType.operator
  else return undefined
}

const walk = (root: SyntaxNode, f: (node: SyntaxNode) => 'bail' | void, debugLabel?: string): void => {
  const recur = (node?: SyntaxNode, depth: number = 0): void => {
    if (!node) return
    if (debugLabel) console.log(`${debugLabel}:`, '  '.repeat(depth), JSON.stringify(node.text), `(${node.type})`)
    const behavior = f(node)
    if (behavior === 'bail') return
    for (const child of node.children) {
      recur(child, depth + 1)
    }
  }
  recur(root)
}

const rangeToString = (range: vscode.Range): string =>
  `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`

const nodeToRange = (node: SyntaxNode): vscode.Range =>
  new vscode.Range(node.startPosition.row, node.startPosition.column, node.endPosition.row, node.endPosition.column)

const mkAddDisposable = (context: vscode.ExtensionContext) => {
  const subscription = new Subscription()
  context.subscriptions.push({ dispose: () => subscription.unsubscribe() })
  return <T extends TeardownLogic | vscode.Disposable>(t: T) => {
    if ('dispose' in t) context.subscriptions.push(t)
    else subscription.add(t)
    return t
  }
}

const observeVisibleTextEditors = (
  addDisposable: <T extends vscode.Disposable>(disposable: T) => T
): Observable<readonly vscode.TextEditor[]> => {
  const hot = new Subject<readonly vscode.TextEditor[]>()

  addDisposable(vscode.window.onDidChangeVisibleTextEditors(es => hot.next(es)))

  const cold = new Observable<readonly vscode.TextEditor[]>(subscriber => {
    ctch(async () => {
      subscriber.next(vscode.window.visibleTextEditors)
      subscriber.add(hot.subscribe(subscriber))
    })
  })

  return cold
}

const ctch = (f: () => Promise<any>): void => {
  f().catch(async e => {
    if (typeof e === 'string') {
      await vscode.window.showErrorMessage(e)
    } else if (e instanceof Error) {
      await vscode.window.showErrorMessage(e.toString())
    } else {
      await vscode.window.showErrorMessage('Unknown error')
    }
  })
}

const singleLineRanges = (range: vscode.Range): vscode.Range[] => {
  const ranges: vscode.Range[] = []
  for (let line = range.start.line; line <= range.end.line; line++) {
    ranges.push(
      new vscode.Range(
        line,
        line === range.start.line ? range.start.character : 0,
        line,
        line === range.end.line ? range.end.character : Number.MAX_SAFE_INTEGER
      )
    )
  }
  return ranges
}

const walkSql = (
  document: vscode.TextDocument,
  goParser: Parser,
  sqlParser: Parser,
  f: (sqlNode: SyntaxNode, range: vscode.Range) => void
): void => {
  const goRoot = goParser.parse(document.getText()).rootNode

  walk(goRoot, goNode => {
    if (isSql(goNode)) {
      const str = goNode.text.slice(1, -1)
      const sqlRoot = sqlParser.parse(str).rootNode
      walk(sqlRoot, sqlNode => {
        const range = new vscode.Range(
          document.positionAt(goNode.startIndex + 1 + sqlNode.startIndex),
          document.positionAt(goNode.startIndex + 1 + sqlNode.endIndex)
        )
        return f(sqlNode, range)
      })
    }
  })
}

const isSql = (node: SyntaxNode): boolean =>
  isString(node) &&
  node.parent?.type === 'argument_list' &&
  node.parent.parent?.type === 'call_expression' &&
  node.parent.parent.childForFieldName('function')!.childForFieldName('field')?.text === 'Exec'

const ancestors = (node: SyntaxNode): SyntaxNode[] => {
  let cur: SyntaxNode | null = node
  const ans: SyntaxNode[] = []
  while (cur !== null) {
    ans.push(cur)
    cur = cur.parent
  }
  return ans.reverse()
}

const positionToPoint = (position: vscode.Position): Parser.Point => ({
  row: position.line,
  column: position.character,
})

const isString = (node: SyntaxNode): boolean =>
  node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal'

const getSqlNodeAt = (
  document: vscode.TextDocument,
  goParser: Parser,
  sqlParser: Parser,
  position: vscode.Position
): [number, SyntaxNode] | undefined => {
  const goRoot = goParser.parse(document.getText()).rootNode
  const node = goRoot.descendantForPosition(positionToPoint(position))
  if (!node) return
  const string = ancestors(node).reverse().filter(isString)[0]
  if (!string) return
  if (document.offsetAt(position) === string.startIndex) return
  if (document.offsetAt(position) === string.endIndex - 1) return
  const str = string.text.slice(1, -1)
  const sqlRoot = sqlParser.parse(str).rootNode
  const stringStart = document.offsetAt(nodeToRange(string).start) + 1
  const indexInSql = document.offsetAt(position) - stringStart
  const sqlNode = sqlRoot.descendantForIndex(indexInSql)
  return [stringStart, sqlNode]
}
