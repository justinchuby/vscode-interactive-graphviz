'use strict';
/**
 * @author github.com/tintinweb
 * @license GPLv3
 *
* */
import * as vscode from "vscode";
import * as settings from '../settings';

export default class PreviewPanel {
    panel: vscode.WebviewPanel;
    uri: vscode.Uri;
    needsRebuild: boolean;
    startedRenders: number;
    lockRender: boolean;
    lastRender: number;
    lastRequest: number;
    waitingForRendering?: string;
    timeoutForWaiting?: NodeJS.Timeout;
    timeoutForRendering?: NodeJS.Timeout;
    enableRenderLock: boolean;
    renderInterval: number;
    debouncingInterval: number;
    guardInterval: number;
    renderLockTimeout: number;
    progressResolve?: (value?:unknown) => void;

    /**
     * Search API types
     */
    search?: {
        text: string;
        options: {
            type: "exact"|"included"|"regex", // used search function
            direction: "bidirectional"|"upstream"|"downstream"|"single",
            nodeName: boolean, // should search in node names
            nodeLabel: boolean, // should search in node labels
            edgeLabel: boolean, // should search in edge labels
        }
    };

    constructor( uri: vscode.Uri,  panel : vscode.WebviewPanel) {
        this.needsRebuild = false;
        this.uri = uri;
        this.panel = panel;
        this.progressResolve = undefined;
        this.startedRenders = 0;

        this.lockRender = false;
        this.lastRender = Date.now();
        this.lastRequest = Date.now();
        this.waitingForRendering = undefined;
        this.timeoutForWaiting = undefined;
        this.timeoutForRendering = undefined;
        this.enableRenderLock = settings.extensionConfig().get("renderLock") as boolean;
        this.renderInterval = settings.extensionConfig().get("renderInterval") as number;
        this.debouncingInterval = settings.extensionConfig().get("debouncingInterval") as number;
        this.guardInterval = settings.extensionConfig().get("guardInterval") as number;

        let renderLockAdditionalTimeout = settings.extensionConfig().get("renderLockAdditionalTimeout") as number;
        let view_transitionDelay = settings.extensionConfig().get("view.transitionDelay") as number;
        let view_transitionaDuration = settings.extensionConfig().get("view.transitionDuration") as number;
        this.renderLockTimeout =
            (this.enableRenderLock && renderLockAdditionalTimeout >= 0) ?
            renderLockAdditionalTimeout + view_transitionDelay + view_transitionaDuration:
            0;
    }

    reveal(displayColumn: vscode.ViewColumn) {
        this.panel.reveal(displayColumn);
    }

    setNeedsRebuild(needsRebuild : boolean) {
        this.needsRebuild = needsRebuild;
    }

    getNeedsRebuild() {
        return this.needsRebuild;
    }

    getPanel() {
        return this.panel;
    }

    // the following functions do not use any locking/synchronization mechanisms, so it may behave weirdly in edge cases

    requestRender(dotSrc: string) {
        let now = Date.now();
        let sinceLastRequest = now - this.lastRequest;
        let sinceLastRender = now - this.lastRender;
        this.lastRequest = now;

        // save the latest content
        this.waitingForRendering = dotSrc;

        // hardcoded:
        // why: to filter out double-events on-save on-change etc, while preserving the ability to monitor fast-changing files etc.
        // what: it delays first render after a period of inactivity (this.guardInterval) has passed
        // how: this is effectively an anti-debounce, it will only pass-through events that come fast enough after the last one,
        //      and delays all others
        let waitFilterFirst = this.guardInterval < sinceLastRequest ? this.guardInterval : 0;
        // will be >0 if there if debouncing is enabled
        let waitDebounce = this.debouncingInterval;
        // will be >0 if there is need to wait bcs. of inter-renderding interval settings
        let waitRenderInterval = this.renderInterval - sinceLastRender;

        let waitBeforeRendering = Math.max(waitFilterFirst, waitDebounce, waitRenderInterval);

        // schedule the last blocked request after the current rendering is finished or when the interval elapses
        if(waitBeforeRendering > 0) {
            // schedule a timeout to render that content later
            // if timeout is already set, we might need to reset it,
            // because we are sharing one timeout for
            // 1) debouncing (**needs** to be delayed everytime),
            // 2) inter-rednering (does not need to be delayed)
            if (waitDebounce > 0 || !this.timeoutForWaiting) {
                if(this.timeoutForWaiting) {
                    clearTimeout(this.timeoutForWaiting);
                }
                this.timeoutForWaiting = setTimeout(
                    () => this.renderWaitingContent(),
                    waitBeforeRendering
                    );
            }
            // scheduled, now return
            console.log("requestRender() scheduling bcs interval, wait: " + waitBeforeRendering);
            return;
        }

        console.log("requestRender() calling renderWaitingContent");
        this.renderWaitingContent();
    }

    // Renders content which has been put in the waiting quue 
    renderWaitingContent() {
        // clear the timeout and null it's handle, we are rendering any waiting content now!
        if (!!this.timeoutForWaiting) {
            console.log("renderWaitingContent() clearing existing timeout");
            clearTimeout(this.timeoutForWaiting);
            this.timeoutForWaiting = undefined;
        }

        if (this.waitingForRendering) {
            // if lock-on-active-rendering is enabled, and it is "locked", return and wait to be called from onRenderFinished
            if(this.enableRenderLock && this.lockRender) {
                console.log("renderWaitingContent() with content, now is locked");
                return;
            }
            let dotSrc = this.waitingForRendering;
            this.waitingForRendering = undefined;
            console.log("renderWaitingContent() with content, calling renderNow");
            this.renderNow(dotSrc);
        }
        else console.log("renderWaitingContent() no content");
    }

    /**
     * Sends the DOT source to the rendering panel
     * @param dotSrc DOT source
     */
    renderNow(dotSrc : string){
        console.log("renderNow()");
        this.lockRender = true;
        this.lastRender = Date.now();
        if (this.renderLockTimeout > 0)
        {
            this.timeoutForRendering = setTimeout(
                () => {
                    console.log("unlocking rendering bcs. of timeout");
                    this.restartRender();
                    vscode.window.showWarningMessage("Graphviz render lock timed out! Maybe change the settings.", "Settings").then((answer) => {
                        if(answer === "Settings") {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'graphviz-interactive-preview.renderLockAdditionalTimeout');
                        }
                    });
                },
                this.renderLockTimeout
                )
        }

        // Send the message to the renderer
        this.panel.webview.postMessage({ command: 'renderDot', value: dotSrc });
        
        // Increase the started renders counter so that only one progress
        // indicator is created.
        this.startedRenders++;
        if(!this.progressResolve) {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Rendering Graphviz View",
                cancellable: false
            }, () => {
                return new Promise(resolve => {
                    this.progressResolve = resolve;
                })
            })
        }
    }

    handleMessage(message: {
            command: any; value?: {
                err: any; // save the latest content
                // save the latest content
                type: string;
                data: string;
            };
        }){
        /** 
         * Dev: handle messages emitted by the graphviz view
         */
        switch(message.command){
            /*
            case 'onClick':
               //do something
                break;
            case 'onDblClick':
                //do something
                break;
            */
            default:
                console.warn('Unexpected command: ' + JSON.stringify(message));
        }
    }

    /**
     * Restarts the renderWaiting function after the render lock has
     * timed out.
     */
    restartRender() {
        if (!!this.timeoutForRendering) {
            clearTimeout(this.timeoutForRendering);
            this.timeoutForRendering = undefined;
        }
        this.lockRender = false;
        this.renderWaitingContent();
    }

    /**
     * Callback from the WebviewPanel after a render has been finished
     * @param err 
     */
    onRenderFinished(err?: NodeJS.ErrnoException){
        if (err)
            console.log("rendering failed: " + err);

        console.log("Render duration: " + (Date.now()-this.lastRender));

        // Decrease startedRenders counter
        this.startedRenders--;
        console.log("started renders:" + this.startedRenders);
        // Hide progress bar after all renders have been finished
        if(this.progressResolve && this.startedRenders===0) {
            this.progressResolve();
            this.progressResolve = undefined;
        }
        this.restartRender();
    }

    /**
     * Called by the Webview after it has been loaded.
     */
    onPageLoaded(){
        this.panel.webview.postMessage({
            command: 'setConfig',
            value : {
                transitionDelay : settings.extensionConfig().get("view.transitionDelay"),
                transitionaDuration : settings.extensionConfig().get("view.transitionDuration")
            }
        });
        this.renderWaitingContent();
    }

    /**
     * Function which is called after disposing of the PreviewPanel
     * (typically after closing the tab)
     */
    dispose() {
        // Resolve all remaining promises on disposal
        if(this.progressResolve) {
            this.progressResolve();
            this.progressResolve = undefined;
        }
    }
}