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
  combineLatest,
  startWith,
  interval,
  window,
  bufferCount,
  reduce,
  scan,
} from 'rxjs'
import Parser, { SyntaxNode } from 'web-tree-sitter'
import * as vscode from 'vscode'
import path from 'path'
import { Client, Connection } from 'pg'
import _ from 'lodash'
import canonicalize from 'canonicalize'
import manifest from '../package.json'
import fs from 'fs/promises'

export async function activate(context: vscode.ExtensionContext) {
  const addDisposable = mkAddDisposable(context)

  const status = addDisposable(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left))
  status.text = 'Wingmate'
  status.show()

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unsafe-member-access
  const extensionPath = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`)!.extensionPath

  const wingmateWasmFile = path.join(extensionPath, 'wingmate.wasm')

  const apis = new BehaviorSubject<API>(await loadWingmate(wingmateWasmFile))

  const abortWatch = new AbortController()
  void catchShow(async () => {
    for await (const _ of fs.watch(wingmateWasmFile, { persistent: false, signal: abortWatch.signal })) {
      void catchShow(async () => {
        apis.next(await loadWingmate(wingmateWasmFile))
      })
    }
  })
  addDisposable(() => abortWatch.abort())

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

  const legend = new vscode.SemanticTokensLegend(Object.values(TokenType).map(t => t.toString()))
  addDisposable(
    combineLatest([sinkss, apis])
      .pipe(
        switchMap(([sinks, api]) => {
          const provider: vscode.DocumentSemanticTokensProvider = {
            provideDocumentSemanticTokens: (
              document: vscode.TextDocument
            ): vscode.ProviderResult<vscode.SemanticTokens> =>
              catchShowRethrow(async () => {
                const tokensBuilder = new vscode.SemanticTokensBuilder(legend)

                for (const { text, offset: strOffset } of allSqlStringsInGo(document, goParser, sinks)) {
                  for (const [offset, len, ty] of api.tokenize(text)) {
                    for (const lineRange of singleLineRanges(
                      new vscode.Range(
                        document.positionAt(strOffset + offset),
                        document.positionAt(strOffset + offset + len)
                      )
                    )) {
                      tokensBuilder.push(lineRange, ty, [])
                    }
                  }
                }

                return tokensBuilder.build()
              }),
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

  const diagnosticsReady = false
  if (diagnosticsReady) {
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
  }

  addDisposable(
    vscode.languages.registerHoverProvider(
      { language: 'go' },
      {
        provideHover: async (document, position, cancellation): Promise<vscode.Hover | undefined> => {
          const result = getSqlNodeAt(document, goParser, sqlParser, position, sinkss.value)
          if (!result) return
          const { offset: stringStart, node: sqlNode } = result
          if (sqlNode.type !== 'identifier') return
          if (!schemas.value) {
            const str = new vscode.MarkdownString(
              `Wingmate is not connected to a DB. Try [reconnecting](command:wingmate.reconnect) or changing the [wingmate.conn setting](command:${settingsCmdLink}).`
            )
            str.isTrusted = true
            return new vscode.Hover(str)
          }
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
          const m = new Map<string, unknown>()
          const key = (column: Column): string => `${column.table_name}.${column.column_name}`
          if (clients.value instanceof Client) {
            for (const column of columnMatches) {
              const res = await clients.value.query<{ sample: unknown }>(
                `SELECT ${column.column_name} AS sample FROM ${column.table_name} LIMIT 1`
              )
              m.set(key(column), res.rows[0]?.sample)
            }
          }
          const summary = (() => {
            if (columnMatches.length === 0) return ''
            const pretty = (c: Column): string => {
              const prettyValue = (v: unknown): string => {
                if (v === null) return 'NULL'
                if (typeof v === 'number') return v.toString()
                const show = (s: string): string => {
                  if (s.length > 30) return `\`${s.slice(0, 30).replaceAll('`', '\\`')}...\``
                  else return `\`${s.replaceAll('`', '\\`')}\``
                }
                if (typeof v === 'string') return show(v)
                return show(JSON.stringify(v))
              }
              const sample =
                m.get(key(c)) === undefined ? '(empty table)' : `first value: \`${prettyValue(m.get(key(c)))}\``
              return `- ${c.table_name}.**${c.column_name}** \`${prettyColumnType(c)}\` ${sample}`
            }
            return `Matches for **${ident}**:\n\n${columnMatches.map(pretty).join('\n')}`
          })()

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

  const reconnects = new Subject<undefined>()

  type ClientType = 'initial' | 'connecting' | Client | Error | 'needs URL'
  const clients = new BehaviorSubject<ClientType>('initial')
  addDisposable(
    combineLatest([connstrs, reconnects.pipe(startWith(undefined))])
      .pipe(
        switchMap(([connstr]) => {
          if (!connstr) return of('needs URL' as const)
          return new Observable<ClientType>(subscriber => {
            const client = new Client(connstr)
            client.on('error', e => subscriber.next(e instanceof Error ? e : new Error('DB connection error')))
            subscriber.next('connecting')
            client.connect().then(
              async () => {
                await client.query(`SET plan_cache_mode = force_generic_plan`)
                subscriber.next(client)
              },
              e => subscriber.next(e instanceof Error ? e : new Error('Failed to connect to postgres'))
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
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        tap(client => {
          if (client === 'initial') return
          if (client === 'connecting') {
            status.text = 'Wingmate ???'
            status.tooltip = 'Connecting to DB...'
            status.command = undefined
          }
          if (client === 'needs URL') {
            status.text = 'Wingmate ???'
            status.tooltip = 'No connection string given.'
            status.command = {
              title: 'Open settings',
              command: 'workbench.action.openSettings',
              arguments: ['wingmate'],
            }
          }
          if (client instanceof Error) {
            status.text = 'Wingmate ???'
            status.tooltip = new vscode.MarkdownString()
              .appendText(`${client.message}.`)
              .appendMarkdown(
                ` Try [reconnecting](command:wingmate.reconnect) or changing the [wingmate.conn setting](command:${settingsCmdLink}).`
              )
            status.tooltip.isTrusted = true
            status.command = {
              title: 'Open settings',
              command: 'workbench.action.openSettings',
              arguments: ['wingmate'],
            }
          }
          if (client instanceof Client) {
            status.text = 'Wingmate ???'
            status.tooltip = `Connected to DB.`
            status.command = undefined
          }
        })
      )
      .subscribe()
  )

  addDisposable(
    clients
      .pipe(
        scan((notify, client) => {
          if (notify && client instanceof Client) {
            void vscode.window.showInformationMessage('Connected to DB ???')
            return false
          }
          if (client instanceof Error) notify = true
          if (client === 'needs URL') notify = true
          return notify
        }, false)
      )
      .subscribe()
  )

  addDisposable(
    clients
      .pipe(
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        tap(async client => {
          if (client instanceof Error) {
            const choice = await vscode.window.showErrorMessage(
              `Failed to connect to postgres: ${client.message}. Try changing the [wingmate.conn setting](command:${settingsCmdLink}).`,
              'Try again'
            )
            if (choice == 'Try again') reconnects.next(undefined)
          }
        })
      )
      .subscribe()
  )

  const refreshSchemas = new Subject<undefined>()

  const schemas = new BehaviorSubject<Column[] | undefined>(undefined)
  addDisposable(
    combineLatest([clients, refreshSchemas.pipe(startWith(undefined))])
      .pipe(
        switchMap(([client]) => {
          if (!(client instanceof Client)) return of(undefined)
          return getSchema(client)
        })
      )
      .subscribe(schemas)
  )

  addDisposable(
    vscode.commands.registerCommand('wingmate.reconnect', () => {
      reconnects.next(undefined)
    })
  )

  let doc: vscode.TextDocument | undefined = undefined

  addDisposable(
    vscode.commands.registerCommand('wingmate.explainQuery', async () => {
      if (!vscode.window.activeTextEditor) {
        await vscode.window.showErrorMessage('There is no active text editor.')
        return
      }
      const str = sqlStringAt(
        vscode.window.activeTextEditor.document,
        goParser,
        sqlParser,
        sinkss.value,
        vscode.window.activeTextEditor.selection.active
      )
      if (!str) {
        await vscode.window.showErrorMessage(
          `Did not recognize any SQL query under the cursor. Make sure it is being passed as an argument to one of the configured [wingmate.sinks](${settingsCmdLink}).`
        )
        return
      }

      if (!(clients.value instanceof Client)) {
        await vscode.window.showErrorMessage(
          `Wingmate is not connected to a DB. Try [reconnecting](command:wingmate.reconnect) or changing the [wingmate.conn setting](command:${settingsCmdLink}).`
        )
        return
      }

      const client = clients.value

      await catchShow(async () => {
        let argCount = 0
        const q = /%s/.test(str.node.text)
          ? str.node.text.replaceAll(/%s/g, () => '$' + (++argCount).toString())
          : /@\w+/.test(str.node.text)
          ? (() => {
              const m = new Map<string, string>()
              return str.node.text.replaceAll(/@\w+/g, v => {
                const found = m.get(v)
                if (found) return found
                const s = '$' + (++argCount).toString()
                m.set(v, s)
                return s
              })
            })()
          : str.node.text
        const re = /\$(\d+)/g
        for (let result = re.exec(q); result !== null; result = re.exec(q)) {
          argCount = Math.max(argCount, parseInt(result[1]))
        }
        const pglist = (str: string, n: number): string => (n === 0 ? '' : `(${Array(n).fill(str).join(',')})`)
        await client.query(`PREPARE _stmt_${pglist('unknown', argCount)} AS ${q}`)
        const res = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (FORMAT TEXT) EXECUTE _stmt_${pglist('NULL', argCount)}`
        )
        await client.query('DEALLOCATE _stmt_')
        const content = res.rows.map(row => row['QUERY PLAN']).join('\n')
        if (!doc) {
          doc = await vscode.workspace.openTextDocument({
            content,
          })
        } else {
          const edit = new vscode.WorkspaceEdit()
          edit.replace(
            doc.uri,
            new vscode.Range(new vscode.Position(0, 0), doc.positionAt(Number.POSITIVE_INFINITY)),
            content
          )
          const success = await vscode.workspace.applyEdit(edit)
          if (!success) {
            await vscode.window.showErrorMessage('Failed to replace the query plan output.')
            return
          }
        }
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true })
        addDisposable(
          vscode.workspace.onDidCloseTextDocument(e => {
            if (e === doc) doc = undefined
          })
        )
      })
    })
  )

  addDisposable(
    vscode.commands.registerCommand('wingmate.refreshSchema', () => {
      if (!(clients.value instanceof Client)) {
        reconnects.next(undefined)
      } else {
        refreshSchemas.next(undefined)
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
  var = 'sqlvar',
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

const sqlStringAt = (
  document: vscode.TextDocument,
  goParser: Parser,
  sqlParser: Parser,
  sinks: Sink[],
  pos: vscode.Position
): EmbeddedSyntaxNode | undefined =>
  allSqlStrings(document, goParser, sqlParser, sinks).find(({ node, offset }) =>
    new vscode.Range(document.positionAt(offset), document.positionAt(offset + node.endIndex)).contains(pos)
  )

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

const allSqlStringsInGo = (
  document: vscode.TextDocument,
  goParser: Parser,
  sinks: Sink[]
): { text: string; offset: number }[] => {
  const ret: { text: string; offset: number }[] = []

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
    ret.push({ text: goStr.text.slice(1, -1), offset: goStr.startIndex + 1 })
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
  mapFn: (arg: json | undefined) => T
): BehaviorSubject<T> => {
  const confs = new BehaviorSubject<json | undefined>(vscode.workspace.getConfiguration(section1).get(section2))
  addDisposable(
    vscode.workspace.onDidChangeConfiguration(() => {
      const value = vscode.workspace.getConfiguration(section1).get(section2)
      if (canonicalize(value) !== confs.value) confs.next(vscode.workspace.getConfiguration(section1).get(section2))
    })
  )
  const ret = new BehaviorSubject<T>(mapFn(confs.value))
  addDisposable(confs.pipe(map(mapFn)).subscribe(ret))
  return ret
}

const getRoot = (node: SyntaxNode): SyntaxNode => {
  let n = node
  while (n.parent) n = n.parent
  return n
}

type Sink = { fn: string; arg: number }

const j2d = (node: SyntaxNode): SyntaxNode | undefined => {
  if (node.type !== 'identifier') return
  const ident = node.text
  for (const ancestor of ancestors(node).reverse()) {
    for (const child of ancestor.namedChildren) {
      if (child.type === 'const_declaration') {
        const str = new Selection(child)
          .namedChild(0)
          .type('const_spec')
          .has(s => s.field('name').text(ident))
          .field('value')
          .namedChild(0)
          .filter(isString)
          .getFirst()
        if (!str) continue
        return str
      } else if (child.type === 'short_var_declaration') {
        const index = new Selection(child)
          .field('left')
          .type('expression_list')
          .namedChildren()
          .text(ident)
          .firstNamedIndex()
        if (index === undefined) continue
        const str = new Selection(child)
          .field('right')
          .type('expression_list')
          .namedChild(index)
          .filter(isString)
          .getFirst()
        if (!str) continue
        return str
      }
    }
  }
}

class Selection {
  nodes: SyntaxNode[] = []
  constructor(node: SyntaxNode) {
    this.nodes = [node]
  }
  flatMap(f: (node: SyntaxNode) => SyntaxNode[]): Selection {
    this.nodes = this.nodes.flatMap(node => f(node))
    return this
  }
  flatMapNullable(f: (node: SyntaxNode) => Nullable<SyntaxNode>): Selection {
    return this.flatMap(node => nullableToArray(f(node)))
  }
  filter(f: (node: SyntaxNode) => boolean): Selection {
    return this.flatMap(node => toArrayIf(node, f(node)))
  }
  field(f: string): Selection {
    return this.flatMapNullable(node => node.childForFieldName(f))
  }
  type(t: string): Selection {
    return this.filter(node => node.type === t)
  }
  namedChildren(): Selection {
    return this.flatMap(node => node.namedChildren)
  }
  namedChild(i: number): Selection {
    return this.flatMapNullable(node => node.namedChild(i))
  }
  text(value: string): Selection {
    return this.filter(node => node.text === value)
  }
  getFirst(): SyntaxNode | undefined {
    return this.nodes[0]
  }
  firstNamedIndex(): number | undefined {
    return this.nodes.flatMap(node => {
      if (!node.parent) return []
      return node.parent.namedChildren.flatMap((sibling, i) => (sibling.id === node.id ? [i] : [])).find(notNull)
    })[0]
  }
  has(f: (s: Selection) => Selection): Selection {
    return this.filter(node => f(new Selection(node)).nodes.length > 0)
  }
}

const nullableToArray = <T>(value: T): NonNullable<T>[] => (value !== null && value !== undefined ? [value] : [])
const toArrayIf = <T>(value: T, when: boolean): T[] => (when ? [value] : [])
const truthy = <T>(value: T): boolean => Boolean(value)
const notNull = <T>(value: T): boolean => value !== undefined && value !== null

type Nullable<T> = T | null | undefined

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

type json = string | number | boolean | null | json[] | { [key: string]: json }

const settingsCmdLink = `workbench.action.openSettings?${encodeURIComponent(JSON.stringify('wingmate'))}`

const showError = (e: unknown) => {
  if (typeof e === 'string') {
    void vscode.window.showErrorMessage(e)
  } else if (e instanceof Error) {
    void vscode.window.showErrorMessage(e.toString())
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  } else if (e && typeof e === 'object' && 'toString' in e && typeof e.toString === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    void vscode.window.showErrorMessage(e.toString())
  } else if (e) {
    void vscode.window.showErrorMessage(JSON.stringify(e))
  } else {
    void vscode.window.showErrorMessage('An unknown error occurred.')
  }
}

const catchShow = async <Ret>(f: () => Promise<Ret>): Promise<Ret | void> => f().catch(showError)

const catchShowRethrow = async <Ret>(f: () => Promise<Ret>): Promise<Ret> =>
  f().catch(e => {
    void showError(e)
    throw e
  })

const countMatches = (str: string, re: RegExp): number => (str.match(re) ?? []).length

type API = {
  /** Returns an array of triplets: (offset, length, type) */
  tokenize: (code: string) => [number, number, string][]
}

const loadWingmate = async (wasmFile: string): Promise<API> => {
  const module = await WebAssembly.compile(await fs.readFile(wasmFile))
  const instance = await WebAssembly.instantiate(module)
  const memory = instance.exports.memory
  const malloc = instance.exports.malloc
  const free = instance.exports.free
  const call = instance.exports.call

  if (!(memory instanceof WebAssembly.Memory)) throw new Error('wasm module is missing memory')
  if (typeof malloc !== 'function') throw new Error('wasm module is missing malloc')
  if (typeof free !== 'function') throw new Error('wasm module is missing free')
  if (typeof call !== 'function') throw new Error('wasm module is missing call')

  const api = <Arg, Ret>(name: string, arg: Arg): Ret => {
    const argBytes = new TextEncoder().encode(JSON.stringify({ [name]: arg }))
    const argLen = argBytes.length
    const argPtr = malloc(argLen) as number
    new Uint8Array(memory.buffer, argPtr + 4).set(argBytes)

    const retPtr = call(argPtr) as number
    free(argPtr)
    const retLen = new Uint32Array(memory.buffer, retPtr)[0]
    const retBytes = memory.buffer.slice(retPtr + 4, retPtr + 4 + retLen)
    type DataOrError = { data: Ret } | { error: string }
    const ret = JSON.parse(new TextDecoder().decode(retBytes)) as DataOrError
    free(retPtr)
    if ('error' in ret) throw new Error(ret.error)
    return ret.data
  }

  return {
    tokenize: code => api('tokenize', code),
  }
}
