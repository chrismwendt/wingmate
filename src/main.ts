import {
  Observable,
  finalize,
  Subject,
  Subscription,
  TeardownLogic,
  BehaviorSubject,
  switchMap,
  map,
  skip,
  skipWhile,
  distinctUntilChanged,
  shareReplay,
  catchError,
  MonoTypeOperatorFunction,
  EMPTY,
  of,
  tap,
  filter,
} from 'rxjs'
import Parser, { SyntaxNode } from 'web-tree-sitter'
import * as vscode from 'vscode'
import path from 'path'
import { Client, Connection } from 'pg'
import _ from 'lodash'

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
  addDisposable(() => sqlParser.delete())
  addDisposable(() => goParser.delete())

  const sinkss = observeConfiguration('wingmate', 'sinks', addDisposable, (sinks: unknown): Sink[] =>
    !Array.isArray(sinks)
      ? []
      : sinks.flatMap(sink => {
          if (typeof sink !== 'string') return []
          const components = sink.split(':')
          if (components.length !== 2) return []
          const arg = parseInt(components[1])
          if (!isFinite(arg)) return []
          return { fn: components[0], arg }
        })
  )

  const legend = new vscode.SemanticTokensLegend(Object.values(TokenType))
  addDisposable(
    sinkss
      .pipe(
        switchMap(sinks => {
          const provider: vscode.DocumentSemanticTokensProvider = {
            provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
              const tokensBuilder = new vscode.SemanticTokensBuilder(legend)

              for (const { node: sqlNode, offset } of allNodesInSqlStrings(document, goParser, sqlParser, sinks)) {
                const tokenType = nodeToTokenType(sqlNode)
                if (tokenType) {
                  for (const lineRange of singleLineRanges(nodeAtOffsetToRange(document, sqlNode, offset))) {
                    tokensBuilder.push(lineRange, tokenType, [])
                  }
                }
              }

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
    sinkss
      .pipe(
        switchMap(prefixes => {
          return observeChangesToDocuments(addDisposable).pipe(
            tap(change => {
              const diags: vscode.Diagnostic[] = []
              switch (change.brand) {
                case 'added':
                case 'modified':
                  if (change.value.languageId !== 'go') break
                  diagnostics.set(
                    change.value.uri,
                    allSqlStrings(change.value, goParser, sqlParser, prefixes).flatMap(str => {
                      if (!shouldReportDiagnostics(str.node)) return []
                      return allNodes(str.node).flatMap(node =>
                        node.type === 'ERROR'
                          ? [
                              new vscode.Diagnostic(
                                nodeAtOffsetToRange(change.value, node, str.offset),
                                `Syntax error in SQL at ${ancestors(node)
                                  .map(ancestor => ancestor.type)
                                  .join('.')}`,
                                vscode.DiagnosticSeverity.Error
                              ),
                            ]
                          : []
                      )
                    })
                  )
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
          const result = getSqlNodeAt(document, goParser, sqlParser, position, sinkss.value)
          if (!result) return
          const { offset: stringStart, node: sqlNode } = result
          if (sqlNode.type !== 'identifier') return
          if (!schemas.value)
            return new vscode.Hover('Wingmate is not connected to a DB. Try changing wingmate.conn in your settings.')
          const ident = sqlNode.text
          const range = new vscode.Range(
            document.positionAt(stringStart + sqlNode.startIndex),
            document.positionAt(stringStart + sqlNode.endIndex)
          )

          const tableDefs = _.chain(schemas.value)
            .groupBy(column => column.table_name)
            .entries()
            .filter(([table, columns]) => table === ident || columns.some(column => column.column_name === ident))
            .map(([table, columns]) => {
              const tableName = table === ident ? `**${table}**` : table
              return (
                `Table ${tableName}:\n\n` +
                '| Column | Type |\n' +
                '| --- | --- |\n' +
                _.sortBy(columns, c => c.column_name)
                  .map(c => {
                    const name = c.column_name === ident ? `**${c.column_name}**` : c.column_name
                    return `| ${name} | \`${prettyColumnType(c)}\` |`
                  })
                  .join('\n')
              )
            })
            .join('\n\n---\n\n')
            .value()

          const columnMatches = schemas.value.filter(c => c.column_name === ident)
          const summary =
            columnMatches.length > 1
              ? `Matches for **${ident}**:\n\n${columnMatches
                  .map(c => `- ${c.table_name}.**${c.column_name}** \`${prettyColumnType(c)}\``)
                  .join('\n')}`
              : columnMatches.length > 0
              ? `**${ident}** ${prettyColumnType(columnMatches[0])}`
              : ''

          return {
            contents: [
              new vscode.MarkdownString(
                tableDefs
                  ? _.compact([summary, tableDefs]).join('\n\n---\n\n')
                  : `**${ident}** not found. Checked ${
                      _.uniq(schemas.value.map(c => c.table_name)).length
                    } tables and ${schemas.value.length} columns. Try running the command "Wingmate: Refresh Schema".`
              ),
            ],
            range,
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
          const result = getSqlNodeAt(document, goParser, sqlParser, position, sinkss.value)
          if (!result) return
          const { offset: stringStart, node: sqlNode } = result
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
    const result = getSqlNodeAt(document, goParser, sqlParser, position, sinkss.value)
    if (!result) return
    const { offset: stringStart, node: sqlNode } = result
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

  const connstrs = observeConfiguration('wingmate', 'conn', addDisposable, (conn: unknown): string | undefined =>
    typeof conn === 'string' ? conn : undefined
  )

  const clients = new BehaviorSubject<Client | undefined>(undefined)
  addDisposable(
    connstrs
      .pipe(
        distinctUntilChanged(),
        switchMap(connstr => {
          if (!connstr) return of(undefined)

          return new Observable<Client>(subscriber => {
            const client = new Client(connstr)

            client.connect().then(
              () => {
                subscriber.next(client)
              },
              async e => {
                subscriber.next(undefined)
                const choice = await vscode.window.showErrorMessage(
                  `Failed to connect to postgres${
                    e instanceof Error ? `: ${e.message}` : ''
                  }. Try changing wingmate.conn in your settings.`,
                  'Open settings'
                )
                if (choice == 'Open settings')
                  await vscode.commands.executeCommand('workbench.action.openSettings', 'wingmate')
              }
            )

            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            return () => client.end()
          })
        })
      )
      .subscribe(clients)
  )

  addDisposable(
    clients
      .pipe(
        filter(x => x !== undefined),
        skip(1),
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        tap(async () => await vscode.window.showInformationMessage('Connected to postgres ✅'))
      )
      .subscribe()
  )

  const schemas = new BehaviorSubject<Column[] | undefined>(undefined)
  addDisposable(
    clients
      .pipe(
        switchMap(client => {
          if (!client) return of(undefined)
          return getSchema(client)
        })
      )
      .subscribe(schemas)
  )

  addDisposable(
    vscode.commands.registerCommand('wingmate.refreshSchema', async () => {
      if (!clients.value) {
        const choice = await vscode.window.showErrorMessage(
          'Wingmate is not connected to a DB. Try changing `wingmate.conn` in your settings.',
          'Open settings'
        )
        if (choice == 'Open settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'wingmate')
      } else {
        schemas.next(await getSchema(clients.value))
      }
    })
  )

  addDisposable(
    vscode.commands.registerTextEditorCommand('wingmate.complete', (editor, _edit, offset: number, value: string) => {
      const pos = editor.document.positionAt(offset)
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      ;(async () => {
        await editor.edit(edit => edit.insert(pos, value))
        editor.selection = new vscode.Selection(pos, pos)
      })()
    })
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
            new vscode.Position(position.line, Math.max(0, position.character - 1)),
            sinkss.value
          )
          if (!result) return

          const { offset: stringStart, node: sqlNode } = result

          if (!schemas.value) return

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

          return schemas.value.map(row => {
            const completion = new vscode.CompletionItem({
              label: row.column_name,
              description: row.table_name,
              detail: ' ' + prettyColumnType(row),
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

const walk = (root: SyntaxNode, f: (node: SyntaxNode) => 'bail' | void): void => {
  const recur = (node?: SyntaxNode, depth = 0): void => {
    if (!node) return
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

const allSqlStrings = (
  document: vscode.TextDocument,
  goParser: Parser,
  sqlParser: Parser,
  sinks: Sink[]
): EmbeddedSyntaxNode[] => {
  const ret: EmbeddedSyntaxNode[] = []

  const goRoot = goParser.parse(document.getText()).rootNode

  walk(goRoot, goNode => {
    if (goNode.type !== 'call_expression') {
      return
    }
    const sink = sinks.find(sink => goNode.childForFieldName('function')?.text?.endsWith(sink.fn))
    if (!sink) {
      return
    }
    const argument_list = goNode.childForFieldName('arguments')
    if (argument_list?.type !== 'argument_list') {
      return
    }
    const arg = argument_list.namedChildren[sink.arg]
    const goStr = isString(arg) ? arg : j2d(arg)
    if (!goStr) {
      return
    }
    const str = goStr.text.slice(1, -1)
    const sqlRoot = sqlParser.parse(str).rootNode
    ret.push({ node: sqlRoot, offset: goStr.startIndex + 1 })
  })

  return ret
}

const allNodesInSqlStrings = (
  document: vscode.TextDocument,
  goParser: Parser,
  sqlParser: Parser,
  sinks: Sink[]
): EmbeddedSyntaxNode[] =>
  allSqlStrings(document, goParser, sqlParser, sinks).flatMap(({ node: sqlRoot, offset }) => {
    const ret: EmbeddedSyntaxNode[] = []
    walk(sqlRoot, node => {
      ret.push({ node, offset })
    })
    return ret
  })

const allNodes = (node: SyntaxNode): SyntaxNode[] => {
  const nodes: SyntaxNode[] = []
  walk(node, n => {
    nodes.push(n)
  })
  return nodes
}

const hasError = (node: SyntaxNode): boolean => {
  let found = false
  walk(node, n => {
    if (found) return 'bail'
    if (n.type === 'ERROR') {
      found = true
      return 'bail'
    }
  })
  return found
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
  sinks: Sink[]
): EmbeddedSyntaxNode | undefined => {
  return allSqlStrings(document, goParser, sqlParser, sinks).flatMap(({ node, offset }) =>
    nodeAtOffsetToRange(document, node, offset).contains(position)
      ? [{ offset, node: node.descendantForIndex(document.offsetAt(position) - offset) }]
      : []
  )[0]
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

type Sink = { fn: string; arg: number }

const j2d = (node: SyntaxNode): SyntaxNode | undefined => {
  if (node.type !== 'identifier') return
  for (const top of getRoot(node).namedChildren) {
    if (top.type !== 'const_declaration') continue
    const const_spec = top.namedChildren[0]
    if (const_spec?.type !== 'const_spec') continue
    if (const_spec.childForFieldName('name')?.text !== node.text) continue
    const str = const_spec.childForFieldName('value')?.namedChildren[0]
    if (!str || !isString(str)) continue
    return str
  }
}

const nodeAtOffsetToRange = (document: vscode.TextDocument, node: SyntaxNode, offset: number): vscode.Range =>
  new vscode.Range(document.positionAt(offset + node.startIndex), document.positionAt(offset + node.endIndex))

type EmbeddedSyntaxNode = { node: SyntaxNode; offset: number }

const prettyRange = (range: vscode.Range): string =>
  `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`

const shouldReportDiagnostics = (node: SyntaxNode): boolean => {
  return /^\s*(SELECT|UPDATE|DELETE|INSERT)/.test(node.text)
}

type Column = {
  table_name: string
  column_name: string
  data_type: string
  column_default: string | null
  is_nullable: 'YES' | 'NO'
}

const getSchema = async (client: Client): Promise<Column[] | undefined> =>
  (
    await client.query<Column>(`
                SELECT table_name, column_name, data_type, column_default, is_nullable
                FROM information_schema.columns
                WHERE table_schema = 'public'
                GROUP BY table_name, column_name, data_type, column_default, is_nullable
              `)
  ).rows

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// function tap<T>(fn: (t: T) => any): MonoTypeOperatorFunction<T> {
//   return o =>
//     o.pipe(
//       // eslint-disable-next-line @typescript-eslint/no-misused-promises
//       tap(async t => {
//         await fn(t)
//       })
//     )
// }

const prettyFullColumn = (column: Column): string =>
  `${column.table_name}.${column.column_name} ${prettyColumnType(column)}`

const prettyColumn = (column: Column): string => `${column.column_name} ${prettyColumnType(column)}`

const prettyColumnType = (column: Column): string => {
  let str = ''
  str += column.data_type.toUpperCase()
  str += column.is_nullable === 'NO' ? ' NOT NULLABLE' : ''
  str += column.column_default !== null ? ' DEFAULT ' + column.column_default : ''
  return str
}
