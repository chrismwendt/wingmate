import {
  Observable,
  finalize,
  Subject,
  Subscription,
  tap,
  TeardownLogic,
  BehaviorSubject,
  switchMap,
  map,
  skip,
  skipWhile,
} from 'rxjs'
import Parser, { SyntaxNode } from 'web-tree-sitter'
import * as vscode from 'vscode'
import path from 'path'
import { Client } from 'pg'

export async function activate(context: vscode.ExtensionContext) {
  await activateAsync(context).catch(e => console.error(e))
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

  const mapPrefixes = (prefixes: unknown): string[] =>
    !Array.isArray(prefixes) ? [] : prefixes.filter((prefix): prefix is string => typeof prefix === 'string')

  const prefixess = observeConfiguration('wingmate', 'prefixes', addDisposable, mapPrefixes)

  const legend = new vscode.SemanticTokensLegend(Object.values(TokenType))
  addDisposable(
    prefixess
      .pipe(
        switchMap(prefixes => {
          const provider: vscode.DocumentSemanticTokensProvider = {
            provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
              const tokensBuilder = new vscode.SemanticTokensBuilder(legend)

              walkSql(document, goParser, sqlParser, prefixes, (sqlNode, range) => {
                const tokenType = nodeToTokenType(sqlNode)
                if (tokenType) {
                  for (const lineRange of singleLineRanges(range)) tokensBuilder.push(lineRange, tokenType, [])
                  return 'bail'
                }
              })

              return tokensBuilder.build()
            },
          }

          return new Observable(() => {
            const disposable = vscode.languages.registerDocumentSemanticTokensProvider(
              { language: 'go' },
              provider,
              legend
            )
            return () => {
              disposable.dispose()
            }
          })
        })
      )
      .subscribe()
  )

  const diagnostics = addDisposable(vscode.languages.createDiagnosticCollection('sql'))
  addDisposable(
    prefixess
      .pipe(
        switchMap(prefixes => {
          return observeChangesToDocuments(addDisposable).pipe(
            tap(change => {
              const diags: vscode.Diagnostic[] = []
              switch (change.brand) {
                case 'added':
                case 'modified':
                  if (change.value.languageId !== 'go') break
                  walkSql(change.value, goParser, sqlParser, prefixes, (sqlNode, range) => {
                    if (sqlNode.type === 'ERROR') {
                      const ancestry = ancestors(sqlNode)
                        .map(ancestor => ancestor.type)
                        .join('.')
                      diags.push(
                        new vscode.Diagnostic(
                          range,
                          `Syntax error in SQL at ${ancestry}`,
                          vscode.DiagnosticSeverity.Error
                        )
                      )
                      return 'bail'
                    }
                  })
                  diagnostics.set(change.value.uri, diags)
                  break
                case 'deleted':
                  diagnostics.set(change.value.uri, [])
                  break
              }
            }),
            finalize(() => diagnostics.clear())
          )
        })
      )
      .subscribe()
  )

  addDisposable(
    vscode.languages.registerHoverProvider(
      { language: 'go' },
      {
        provideHover: (document, position, cancellation): vscode.ProviderResult<vscode.Hover> => {
          const result = getSqlNodeAt(document, goParser, sqlParser, position, prefixess.value)
          if (!result) return
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
    vscode.languages.registerDefinitionProvider(
      { language: 'go' },
      {
        provideDefinition: (document, position, cancellation): vscode.ProviderResult<vscode.Definition> => {
          const result = getSqlNodeAt(document, goParser, sqlParser, position, prefixess.value)
          if (!result) return
          const [stringStart, sqlNode] = result
          if (sqlNode.type !== 'identifier') return
          for (let node: SyntaxNode | null = sqlNode; node !== null; node = node.parent) {
            if (node.type !== 'statement') continue
            for (const cte of node.namedChildren.filter(n => n.type === 'cte')) {
              const identifier = cte.namedChildren.find(n => n.type === 'identifier')
              if (!identifier) continue
              if (identifier.text === sqlNode.text)
                return {
                  uri: document.uri,
                  range: new vscode.Range(
                    document.positionAt(stringStart + identifier.startIndex),
                    document.positionAt(stringStart + identifier.endIndex)
                  ),
                }
            }
          }
        },
      }
    )
  )

  const findRefs = (
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Location[]> => {
    const result = getSqlNodeAt(document, goParser, sqlParser, position, prefixess.value)
    if (!result) return
    const [stringStart, sqlNode] = result
    if (sqlNode.type !== 'identifier') return
    const root = getRoot(sqlNode)
    const locs: vscode.Location[] = []
    walk(root, node => {
      if (node.type !== 'identifier') return
      if (node.text !== sqlNode.text) return
      locs.push(
        new vscode.Location(
          document.uri,
          new vscode.Range(
            document.positionAt(stringStart + node.startIndex),
            document.positionAt(stringStart + node.endIndex)
          )
        )
      )
    })
    return locs
  }

  addDisposable(vscode.languages.registerReferenceProvider({ language: 'go' }, { provideReferences: findRefs }))

  addDisposable(
    vscode.languages.registerDocumentHighlightProvider({ language: 'go' }, { provideDocumentHighlights: findRefs })
  )

  const conns = observeConfiguration('wingmate', 'conn', addDisposable, (conn: unknown): string | undefined =>
    typeof conn === 'string' ? conn : undefined
  )

  addDisposable(
    conns
      .pipe(
        skip(1),
        // skipWhile(conn => conn?.includes('localhost:5432'))
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        tap(async conn => {
          try {
            const client = new Client(conn)
            await client.connect()
            await vscode.window.showInformationMessage('Connected to postgres ✅')
          } catch (e) {
            if (e instanceof Error) await vscode.window.showErrorMessage(`Failed to connect to postgres: ${e.message}`)
            else await vscode.window.showErrorMessage('Failed to connect to postgres')
          }
        })
      )
      .subscribe()
  )

  addDisposable(
    vscode.commands.registerTextEditorCommand('wingmate.complete', (editor, edit, offset: number, value: string) => {
      edit.insert(editor.document.positionAt(offset), value)
    })
  )

  const autocompleteReady = true
  if (autocompleteReady) {
    addDisposable(
      vscode.languages.registerCompletionItemProvider(
        { language: 'go' },
        {
          // Completion inside strings is disabled by default, need to enable it:
          // https://github.com/microsoft/vscode/issues/23962#issuecomment-292079416
          provideCompletionItems: async (document, position, cancellation, context) => {
            const result = getSqlNodeAt(
              document,
              goParser,
              sqlParser,
              new vscode.Position(position.line, Math.max(0, position.character - 1)),
              prefixess.value
            )
            if (!result) return

            const conn = conns.value
            if (!conn) return
            const client = new Client(conn)
            try {
              await client.connect()
            } catch (e) {
              // don't spam
              return
            }

            const [stringStart, sqlNode] = result

            const res = await client.query<{
              table_name: string
              column_name: string
              data_type: string
              column_default: string | null
              is_nullable: 'YES' | 'NO'
            }>(
              "select table_name, column_name, data_type, column_default, is_nullable from information_schema.columns where table_schema = 'public' group by table_name, column_name, data_type, column_default, is_nullable;"
            )

            const suggestion = ((): { alias: string | undefined; identLen: number; fromOffset: number } | undefined => {
              if (sqlNode.type !== 'identifier') return
              const parent = sqlNode.parent
              if (!parent) return
              const alias = parent.childForFieldName('table_alias')
              const select = ancestors(sqlNode)
                .reverse()
                .find(n => n.type === 'select')
              if (!select) return
              let from: SyntaxNode | undefined = undefined
              for (let n: SyntaxNode | null = select; n; n = n?.nextNamedSibling) {
                if (n?.type === 'from') from = n
              }
              if (from && from.namedChildren.some(n => n.type === 'from_clause')) return
              return {
                alias: alias?.text,
                identLen: sqlNode.text.length,
                fromOffset: select.endIndex,
              }
            })()

            const ret = res.rows.map(row => {
              const completion = new vscode.CompletionItem({
                label: row.column_name,
                description: row.table_name,
                detail:
                  ' ' +
                  row.data_type.toUpperCase() +
                  (row.is_nullable === 'NO' ? ' NOT NULLABLE' : '') +
                  (row.column_default !== null ? ' DEFAULT ' + row.column_default : ''),
              })
              if (suggestion) {
                completion.command = {
                  title: 'title',
                  command: 'wingmate.complete',
                  arguments: [
                    stringStart + suggestion.fromOffset + (row.column_name.length - suggestion.identLen),
                    ` FROM ${row.table_name}${suggestion.alias ? ` ${suggestion.alias}` : ''}`,
                  ],
                }
              }

              return completion
            })
            await client.end()
            return ret
          },
        }
      )
    )
  }
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
  const recur = (node?: SyntaxNode, depth = 0): void => {
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

type AddDisposable = <T extends TeardownLogic | vscode.Disposable>(t: T) => T

type Diff3<T> = { brand: 'added' | 'modified' | 'deleted'; value: T }

const observeChangesToDocuments = (addDisposable: AddDisposable): Observable<Diff3<vscode.TextDocument>> => {
  const docs = new Map<string, vscode.TextDocument>()
  const sub = new Subject<Diff3<vscode.TextDocument>>()
  for (const e of vscode.window.visibleTextEditors) {
    docs.set(e.document.uri.toString(), e.document)
  }
  addDisposable(
    vscode.workspace.onDidCloseTextDocument(e => {
      docs.delete(e.uri.toString())
      sub.next({ brand: 'deleted', value: e })
    })
  )
  addDisposable(
    vscode.workspace.onDidOpenTextDocument(e => {
      docs.set(e.uri.toString(), e)
      sub.next({ brand: 'added', value: e })
    })
  )
  addDisposable(vscode.workspace.onDidChangeTextDocument(e => sub.next({ brand: 'modified', value: e.document })))

  return new Observable(subscriber => {
    for (const doc of [...docs.values()]) {
      subscriber.next({ brand: 'added', value: doc })
    }
    subscriber.add(sub.subscribe(subscriber))
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
  prefixes: string[],
  f: (sqlNode: SyntaxNode, range: vscode.Range) => void
): void => {
  const goRoot = goParser.parse(document.getText()).rootNode

  walk(goRoot, goNode => {
    if (isSql(document, goNode, prefixes)) {
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

const isSql = (document: vscode.TextDocument, node: SyntaxNode, prefixes: string[]): boolean => {
  if (!isString(node)) return false
  const leading = document.getText(new vscode.Range(new vscode.Position(0, 0), document.positionAt(node.startIndex)))
  return prefixes.some(prefix => leading.endsWith(prefix))
}

/** Returns [program, statement, ..., identifier] */
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
  position: vscode.Position,
  prefixes: string[]
): [number, SyntaxNode] | undefined => {
  const goRoot = goParser.parse(document.getText()).rootNode
  const node = goRoot.descendantForPosition(positionToPoint(position))
  if (!node) return
  const string = ancestors(node).reverse().filter(isString)[0]
  if (!string) return
  if (!isSql(document, string, prefixes)) return
  if (document.offsetAt(position) === string.startIndex) return
  if (document.offsetAt(position) === string.endIndex - 1) return
  const str = string.text.slice(1, -1)
  const sqlRoot = sqlParser.parse(str).rootNode
  const stringStart = document.offsetAt(nodeToRange(string).start) + 1
  const indexInSql = document.offsetAt(position) - stringStart
  const sqlNode = sqlRoot.descendantForIndex(indexInSql)
  return [stringStart, sqlNode]
}

const observeConfiguration = <T>(
  section1: string,
  section2: string,
  addDisposable: AddDisposable,
  mapFn: (arg: unknown) => T
): BehaviorSubject<T> => {
  const behaviorSubject = new BehaviorSubject(mapFn(vscode.workspace.getConfiguration(section1).get(section2)))
  addDisposable(
    vscode.workspace.onDidChangeConfiguration(() => {
      behaviorSubject.next(mapFn(vscode.workspace.getConfiguration(section1).get(section2)))
    })
  )
  return behaviorSubject
}

const getRoot = (node: SyntaxNode): SyntaxNode => {
  let n = node
  while (n.parent) n = n.parent
  return n
}
