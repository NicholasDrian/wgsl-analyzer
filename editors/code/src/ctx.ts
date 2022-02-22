import { readFile } from "fs";
import fetch from "node-fetch";
import { promisify } from "util";
import * as lsp_ext from "./lsp_ext";
import * as vscode from "vscode";
import { Disposable, ExtensionContext } from "vscode";
import { Executable, LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";
import { Config } from "./config";
import { isWgslEditor, WgslEditor } from "./util";


interface WGSLAnalyzerConfiguration {
    showTypeErrors: boolean,
    customImports: Record<string, string>,
    trace: { extension: boolean, server: boolean; };
}

async function lspOptions(config: Config): Promise<WGSLAnalyzerConfiguration> {
    let start = process.hrtime();
    let customImports = await mapObjectAsync(config.customImports, resolveImport, (name, _, val) => {
        vscode.window.showErrorMessage(`WGSL-Analyzer: failed to resolve import \`${name}\`: ${val}`);
    });
    let elapsed = process.hrtime(start);
    let millis = elapsed[0] * 1000 + elapsed[1] / 1_000_000;
    if (millis > 1000) {
        vscode.window.showWarningMessage(`WGSL-Analalyzer: Took ${millis.toFixed(0)}ms to resolve imports.`);
    }

    return {
        customImports,
        showTypeErrors: config.showTypeErrors,
        trace: config.trace,
    };
}

export class Ctx {
    private constructor(readonly ctx: ExtensionContext, readonly client: LanguageClient) { }

    static async create(serverPath: string, ctx: ExtensionContext, config: Config) {
        const run: Executable = {
            command: serverPath,
        };
        const serverOptions: ServerOptions = {
            run,
            debug: run,
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [{ language: "wgsl" }, { scheme: "file", pattern: "*.wgsl" }],
            outputChannelName: "WGSL Analyzer",
            initializationOptions: await lspOptions(config),
        };

        let client = new LanguageClient(
            "wgsl_analyzer",
            "WGSL Language server",
            serverOptions,
            clientOptions
        );

        client.start();
        await client.onReady();

        ctx.subscriptions.push(client.onRequest(lsp_ext.requestConfiguration, async (_, ct) => {
            vscode.window.showInformationMessage("requestConfiguration");
            let options = await lspOptions(config);
            vscode.window.showInformationMessage("requestConfiguration: " + JSON.stringify(options));
            return options;
        }));


        return new Ctx(ctx, client);
    }


    registerCommand(name: string, factory: (ctx: Ctx) => Cmd) {
        const fullName = `wgsl-analyzer.${name}`;
        const cmd = factory(this);
        const dispoable = vscode.commands.registerCommand(fullName, cmd);
        this.pushCleanup(dispoable);
    }

    pushCleanup(disposable: Disposable) {
        this.ctx.subscriptions.push(disposable);
    }


    get subscriptions(): Disposable[] {
        return this.ctx.subscriptions;
    }

    get activeWgslEditor(): WgslEditor | undefined {
        const editor = vscode.window.activeTextEditor;
        return editor && isWgslEditor(editor)
            ? editor
            : undefined;
    }
}

function parseUrl(url: string): vscode.Uri | undefined {
    try {
        return vscode.Uri.parse(url, true);
    } catch {
        return undefined;
    }
}

async function resolveImport(content: string): Promise<string> {
    let uri = parseUrl(content);

    if (uri !== undefined) {
        if (uri.scheme == "file") {
            return promisify(readFile)(uri.fsPath, "utf-8");
        } else if (["http", "https"].includes(uri.scheme)) {
            return fetch(content).then(res => res.text());
        } else {
            throw new Error(`unknown scheme \`${uri.scheme}\``);
        }
    } else {
        return content;
    }
}

async function mapObjectAsync<T, U>(object: Record<string, T>, f: (val: T) => Promise<U>, handleError?: (key: string, val: T, error: unknown) => void): Promise<Record<string, U>> {
    let map = async ([key, value]) => {
        try {
            const mapped = await f(value);
            return ([key, mapped]);
        } catch (e) {
            handleError && handleError(key, value, e);
            return undefined;
        }
    };
    let entries = await Promise.all(Object.entries(object).map(map));
    return Object.fromEntries(entries.filter(entry => entry !== undefined));
}

export type Cmd = (...args: any[]) => unknown;