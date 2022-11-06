import { Observable, Subject, Subscription, tap, TeardownLogic } from 'rxjs'

import * as vscode from 'vscode'

export async function activate(context: vscode.ExtensionContext) {
  activateAsync(context).catch(e => console.error(e))
}

export async function activateAsync(context: vscode.ExtensionContext) {
  const addDisposable = mkAddDisposable(context)

  console.log('hello, world')

  addDisposable(
    observeVisibleTextEditors(addDisposable)
      .pipe(tap(editors => console.log(editors)))
      .subscribe()
  )
}

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
