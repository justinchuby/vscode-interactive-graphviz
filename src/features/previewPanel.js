'use strict';
/**
 * @author github.com/tintinweb
 * @license MIT
 *
* */

const vscode = require("vscode");

class PreviewPanel {

    constructor( parent, uri,  panel) {
        this.parent = parent;
        this.needsRebuild = false;
        this.uri = uri;
        this.panel = panel;
        this.progressResolve = null;
        this.startedRenders = 0;

        this.lockRender = false;
        this.lastRender = Date.now();
        this.lastRequest = Date.now();
        this.waitingForRendering = null;
        this.timeoutForWaiting = null;
        this.timeoutForRendering = null;
        this.enableRenderLock = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("renderLock");
        this.renderInterval = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("renderInterval");
        this.debouncingInterval = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("debouncingInterval");
        this.guardInterval = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("guardInterval");

        let renderLockAdditionalTimeout = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("renderLockAdditionalTimeout");
        let view_transitionDelay = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("view.transitionDelay");
        let view_transitionaDuration = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("view.transitionDuration");
        this.renderLockTimeout =
            (this.enableRenderLock && renderLockAdditionalTimeout >= 0) ?
            renderLockAdditionalTimeout + view_transitionDelay + view_transitionaDuration :
            0;

        this.panel.onDidDispose()
    }

    reveal(displayColumn) {
        this.panel.reveal(displayColumn);
    }

    setNeedsRebuild(needsRebuild) {
        this.needsRebuild = needsRebuild;
    }

    getNeedsRebuild() {
        return this.needsRebuild;
    }

    getPanel() {
        return this.panel;
    }

    // the following functions do not use any locking/synchronization mechanisms, so it may behave weirdly in edge cases

    requestRender(dotSrc) {
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
                clearTimeout(this.timeoutForWaiting);
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

    renderWaitingContent() {
        // clear the timeout and null it's handle, we are rendering any waiting content now!
        if (!!this.timeoutForWaiting) {
            console.log("renderWaitingContent() clearing existing timeout");
            clearTimeout(this.timeoutForWaiting);
            this.timeoutForWaiting = null;
        }

        if (this.waitingForRendering) {
            // if lock-on-active-rendering is enabled, and it is "locked", return and wait to be called from onRenderFinished
            if(this.enableRenderLock && this.lockRender) {
                console.log("renderWaitingContent() with content, now is locked");
                return;
            }
            let dotSrc = this.waitingForRendering;
            this.waitingForRendering = null;
            console.log("renderWaitingContent() with content, calling renderNow");
            this.renderNow(dotSrc);
        }
        else console.log("renderWaitingContent() no content");
    }

    renderNow(dotSrc){
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

        this.panel.webview.postMessage({ command: 'renderDot', value: dotSrc });
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

    handleMessage(message){
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

    restartRender() {
        if (!!this.timeoutForRendering) {
            clearTimeout(this.timeoutForRendering);
            this.timeoutForRendering = null;
        }
        this.lockRender = false;
        this.renderWaitingContent();
    }

    onRenderFinished(err){
        if (err)
            console.log("rendering failed: " + err);

        console.log("Render duration: " + (Date.now()-this.lastRender));

        this.startedRenders--;
        console.log("started renders:" + this.startedRenders);
        if(this.progressResolve && this.startedRenders===0) {
            this.progressResolve();
            this.progressResolve = null;
        }
        this.restartRender();
    }

    onPageLoaded(){
        this.panel.webview.postMessage({
            command: 'setConfig',
            value : {
                transitionDelay : vscode.workspace.getConfiguration('graphviz-interactive-preview').get("view.transitionDelay"),
                transitionaDuration : vscode.workspace.getConfiguration('graphviz-interactive-preview').get("view.transitionDuration")
            }
        });
        this.renderWaitingContent();
    }
}

module.exports = PreviewPanel;