import * as vscode from "vscode";
import axios from "axios";
axios.defaults.timeout = 3000;
import { promisify } from "util";
const sleep = promisify(setTimeout);

export class CoverageWatcher {
  // Associate file names to arrays of covered line ranges
  private coverage = new Map<string, Set<vscode.Range>>();
  private active = true;
  private greenHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: "green",
  });

  // Start polling syz-manager's URL
  async start() {
    this.active = true;
    while (this.active) {
      // Fetch the current coverage, parse it and highlight it
      this.coverage = await this.fetchCoverage();
      this.updateHighlights();

      // And wait some time before polling again
      const pollingPeriod : number = vscode.workspace.getConfiguration()
          .get("syzkaller-coverage.polling-period")!;
      if (pollingPeriod === -1) {
        return;
      }
      await sleep(pollingPeriod);
    }
  }

  // Stop polling syz-manager's URL and clear the highlights
  stop() {
    this.active = false;
    this.coverage = new Map();
    this.updateHighlights();
  }

  async fetchCoverage() : Promise<Map<string, Set<vscode.Range>>> {
    let coverage = new Map<string, Set<vscode.Range>>();

    // syz-manager has several HTTP endpoints but rawcoverfiles provides us the
    // most data with the least efforts
    const serverUrl = vscode.workspace.getConfiguration().get("syzkaller-coverage.url")!;
    let coverageStr = "";
    try {
      let res = await axios.get(`${serverUrl}/rawcoverfiles`);
      coverageStr = res.data.toString();
    } catch (err) {
      vscode.window.showErrorMessage("Could not fetch syzkaller coverage at " + serverUrl + ". Is syz-manager running ?");
    }

    // Each line (except the first one that is skipped) is of form:
    // PC,Module,Offset,Filename,StartLine,EndLine
    let lines = coverageStr.split("\n");
    lines.shift();
    lines.forEach(line => {
      let parts = line.split(",");
      if (parts.length < 6) {
        return;
      }
      let filename = parts[3];
      let start = parts[4];
      let end = parts[5];

      let range = new vscode.Range(
        new vscode.Position(Number(start)-1, Number(0)),
        new vscode.Position(Number(end), Number(0))
      );

      // Add that range to the list of ranges associated with filename
      let ranges = coverage.get(filename);
      if (ranges) {
        ranges.add(range);
      } else {
        coverage.set(filename, new Set([range]));
      }
    });

    return coverage;
  }

  updateHighlights() {
    // Update all visible text editors
    vscode.window.visibleTextEditors.forEach(editor => {
      // Find the ranges associated with the file in that editor and color them
      let workspaceUri = "";
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length) {
        workspaceUri = workspaceFolders[0].uri.toString() + "/";
      }
      let editorUri = editor.document.uri.toString();
      editorUri = editorUri.replace(workspaceUri, "");
      const ranges = this.coverage.get(editorUri) || [];
      editor.setDecorations(this.greenHighlight, Array.from(ranges));
    });
  }
}

export function activate(context: vscode.ExtensionContext) {
  let watcher = new CoverageWatcher();

  // Create a status bar item that toggles coverage
  let statusBarItem: vscode.StatusBarItem =
      vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.text = "$(close) syz cov";
  statusBarItem.command = "syzkaller-coverage.toggle";
  statusBarItem.show();

  // The toggling is implemented by a command
  context.subscriptions.push(
    vscode.commands.registerCommand("syzkaller-coverage.toggle", async () => {
      // That either starts the coverage watcher or stops it
      if (statusBarItem.text === "$(close) syz cov") {
        statusBarItem.text = "$(check) syz cov";
        await watcher.start();
      } else {
        statusBarItem.text = "$(close) syz cov";
        watcher.stop();
      }
    })
  );

  // When visible text editors change, update the highlights
  vscode.window.onDidChangeVisibleTextEditors(() => {
    watcher.updateHighlights();
  });
}
