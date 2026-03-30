// This is visualization for cursor positions in the preview pane
// Request for its position are initiated from:
// 1) backend preview_server when Data Plane receives new/diff-v1 updates
// 2) explicitly requested by editor->preview_ws(control plane) on clicks/cursor moves

// Gets cursorPaths from preview websocket
// queries the current svg.typst-doc to match cursor paths
// appends cursor circles to those elements
// keeps the state so that svg re-renders can re-apply the cursor positions

import { tmClassNames, tmEvents } from "../constants";

type CursorParams = {
    textSelector: string;
    charIndex: number;
};

type CursorState = {
    params: CursorParams;
    updatedAt: number;
    circle: SVGCircleElement | null;
};

const CURSOR_STALE_MS = 60_000;
const UNKNOWN_TAB_KEY = "__unknown__";
const OWNER_CURSOR_COLOR = "#66bab7";
const UNKNOWN_CURSOR_COLOR = "#9ca3af";
const REMOTE_CURSOR_COLORS = [
    "#60a5fa",
    "#f59e0b",
    "#a78bfa",
    "#f472b6",
    "#34d399",
    "#f87171",
    "#06b6d4",
    "#eab308",
];

export class PreviewCursor {
    private previewElement: HTMLElement;
    private overlayElement: HTMLDivElement | null = null;
    private overlaySvg: SVGSVGElement | null = null;

    private latestCursorRequesterTabId: string = "";
    private cursorStates = new Map<string, CursorState>();

    private onViewportChange: () => void;
    private spotlightEnabled = true;
    private readonly uniqueTabId: string;

    constructor(previewElement: HTMLElement, uniqueTabId?: string) {
        this.previewElement = previewElement;
        this.uniqueTabId = uniqueTabId || "";

        this.destroy = this.destroy.bind(this);
        this.pathToSelector = this.pathToSelector.bind(this);
        this.showCursor = this.showCursor.bind(this);
        this.onViewportChange = this.showCursorWithoutEmit.bind(this);
        window.$tmEventBus.listen(
            tmEvents.DataCursorPaths,
            this.pathToSelector,
        );
        window.$tmEventBus.listen(
            tmEvents.PreviewCursorRequest,
            ({ uniqueTabId }: { uniqueTabId?: string }) => {
                this.latestCursorRequesterTabId = uniqueTabId || "";
            },
        );

        window.$tmEventBus.listen(tmEvents.DataCursorShow, this.showCursor);
        window.$tmEventBus.listen(
            tmEvents.CursorSpotlightToggle,
            ({ enabled }: { enabled?: boolean }) => {
                this.spotlightEnabled = Boolean(enabled);
                if (!this.spotlightEnabled) {
                    this.hideCursor();
                } else {
                    this.onViewportChange();
                }
            },
        );
        window.$tmEventBus.listen(tmEvents.Destroy, this.destroy);

        this.previewElement.addEventListener("scroll", this.onViewportChange, {
            passive: true,
        });
        window.addEventListener("resize", this.onViewportChange, {
            passive: true,
        });
    }

    private ensureOverlay(): void {
        if (this.overlayElement && this.overlaySvg) return;

        if (getComputedStyle(this.previewElement).position === "static") {
            this.previewElement.style.position = "relative";
        }

        this.overlayElement = document.createElement("div");
        this.overlayElement.className = tmClassNames.PreviewCursorOverlay;
        Object.assign(this.overlayElement.style, {
            position: "absolute",
            inset: "0",
            pointerEvents: "none",
            zIndex: "10",
        });

        this.overlaySvg = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
        );
        this.overlaySvg.setAttribute("width", "100%");
        this.overlaySvg.setAttribute("height", "100%");
        this.overlaySvg.style.overflow = "visible";

        this.overlayElement.appendChild(this.overlaySvg);
        this.previewElement.appendChild(this.overlayElement);
    }

    private getTabKey(uniqueTabId?: string): string {
        return uniqueTabId && uniqueTabId.length > 0
            ? uniqueTabId
            : UNKNOWN_TAB_KEY;
    }

    private isOwnerTab(tabKey: string): boolean {
        return (
            tabKey !== UNKNOWN_TAB_KEY &&
            this.uniqueTabId.length > 0 &&
            tabKey === this.uniqueTabId
        );
    }

    private getCursorColor(tabKey: string): string {
        if (tabKey === UNKNOWN_TAB_KEY) {
            return UNKNOWN_CURSOR_COLOR;
        }
        if (this.isOwnerTab(tabKey)) {
            return OWNER_CURSOR_COLOR;
        }

        let hash = 0;
        for (let index = 0; index < tabKey.length; index++) {
            hash = (hash * 31 + tabKey.charCodeAt(index)) >>> 0;
        }
        return REMOTE_CURSOR_COLORS[hash % REMOTE_CURSOR_COLORS.length];
    }

    private createCursorCircle(color: string): SVGCircleElement {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("fill", color);
        circle.setAttribute("fill-opacity", "0.25");
        circle.setAttribute("stroke", color);
        circle.setAttribute("stroke-opacity", "0.65");
        circle.setAttribute("stroke-width", "1.5");
        circle.dataset.cursorIndicator = "true";
        circle.style.pointerEvents = "none";
        circle.style.transition = "cx 0.1s ease, cy 0.1s ease, r 0.1s ease";
        return circle;
    }

    private removeTabCursor(tabKey: string): void {
        const state = this.cursorStates.get(tabKey);
        if (!state) {
            return;
        }
        state.circle?.remove();
        this.cursorStates.delete(tabKey);
    }

    private pruneStaleCursors(): void {
        const now = Date.now();
        for (const [tabKey, state] of this.cursorStates) {
            if (now - state.updatedAt > CURSOR_STALE_MS) {
                state.circle?.remove();
                this.cursorStates.delete(tabKey);
            }
        }
    }

    private resolveCursorParams(paths: any): CursorParams | null {
        if (!Array.isArray(paths)) {
            return null;
        }

        if (!this.spotlightEnabled) {
            return null;
        }

        const kindMap: Record<number, string> = {
            0: ".typst-text", // g
            1: ".typst-group", // g
            2: ".typst-image", // ?
            3: ".typst-shape", // path
            4: ".typst-page", // g
            5: "use", // theoretically .tsel, but actually "use" tag
        };

        const result = paths.reduce(
            (cursorMax: CursorParams, steps: any[]) => {
                const pairs: [string, number][] = steps.map((step: any) => [
                    kindMap[Number(step.kind)] ?? "???",
                    step.index + 1, // Convert to 1-based index for CSS
                ]);

                const pageStep = pairs.shift();
                const topGroupStep = pairs.shift();

                if (!pageStep || !topGroupStep) {
                    console.warn(
                        "[Preview WASM] Invalid cursor path: insufficient steps",
                    );
                    return cursorMax;
                }

                const topGroup =
                    `svg.typst-doc > :nth-child(${pageStep[1]} of .typst-page)` +
                    ` > :nth-child(${topGroupStep[1]} of [data-tid])`;
                // + ` > :nth-child(${topGroupStep[1]} of :is(.typst-group,.typst-text,.typst-image,.typst-shape))`;

                let charStep = pairs.pop();
                if (!charStep || charStep[0] !== "use") {
                    if (charStep) {
                        pairs.push(charStep);
                    }
                    charStep = ["use", 1];
                }

                const textSelector = pairs.reduce(
                    (selector: string, [tag, child]: [string, number]) =>
                        selector +
                        `> :nth-child(${child} of :has(>g>:not(g:empty)))>g`,
                    topGroup,
                );

                const textNode = document.querySelector(textSelector);

                if (!textNode) {
                    console.warn(
                        "[Preview WASM] Text node not found for selector:",
                        textSelector,
                    );
                    return cursorMax;
                }
                return { textSelector, charIndex: charStep[1] };
            },
            {
                textSelector: "svg.typst-doc>g.typst-group",
                charIndex: 0,
            } as CursorParams,
        );

        if (!result.textSelector || result.charIndex <= 0) {
            return null;
        }

        return result;
    }

    private pathToSelector(paths: any): void {
        if (!this.spotlightEnabled) {
            return;
        }

        const tabKey = this.getTabKey(this.latestCursorRequesterTabId);
        const params = this.resolveCursorParams(paths);
        if (!params) {
            return;
        }

        const prev = this.cursorStates.get(tabKey);
        this.cursorStates.set(tabKey, {
            params,
            updatedAt: Date.now(),
            circle: prev?.circle ?? null,
        });

        this.showAllCursors(this.isOwnerTab(tabKey));
    }

    private showCursorWithoutEmit(): void {
        this.showAllCursors(false);
    }

    /**
     * Show cursor circle at the specified glyph position
     */
    private showCursor(emitPosition: boolean = true): void {
        this.showAllCursors(emitPosition);
    }

    private showAllCursors(emitOwnerPosition: boolean = true): void {
        if (!this.spotlightEnabled) {
            this.hideCursor();
            return;
        }

        this.ensureOverlay();
        if (!this.overlaySvg) {
            return;
        }

        this.pruneStaleCursors();

        for (const [tabKey, state] of this.cursorStates) {
            const textNode = document.querySelector(state.params.textSelector);
            if (!textNode) {
                continue;
            }

            const glyphNode = textNode.querySelector(
                `:nth-child(${state.params.charIndex} of use,path)`,
            ) as SVGGraphicsElement | null;
            if (!glyphNode) {
                continue;
            }

            if (!state.circle) {
                state.circle = this.createCursorCircle(this.getCursorColor(tabKey));
                this.overlaySvg.appendChild(state.circle);
            }

            const glyphRect = glyphNode.getBoundingClientRect();
            const overlayRect = this.overlaySvg.getBoundingClientRect();
            const previewRect = this.previewElement.getBoundingClientRect();

            const cx = glyphRect.left - overlayRect.left + glyphRect.width / 2;
            const cy = glyphRect.top - overlayRect.top + glyphRect.height / 2;
            const r = Math.min(
                30,
                Math.max(15, Math.max(glyphRect.width, glyphRect.height) / 2),
            );

            state.circle.setAttribute("cx", cx.toFixed(2));
            state.circle.setAttribute("cy", cy.toFixed(2));
            state.circle.setAttribute("r", r.toFixed(2));

            if (!emitOwnerPosition || !this.isOwnerTab(tabKey)) {
                continue;
            }

            const contentX =
                glyphRect.left -
                previewRect.left +
                this.previewElement.scrollLeft +
                glyphRect.width / 2;
            const contentY =
                glyphRect.top -
                previewRect.top +
                this.previewElement.scrollTop +
                glyphRect.height / 2;
            window.$tmEventBus.emit(tmEvents.PreviewCursorPosition, {
                contentX,
                contentY,
                width: glyphRect.width,
                height: glyphRect.height,
            });
        }
    }

    private hideCursor(): void {
        for (const [tabKey, state] of this.cursorStates) {
            state.circle?.remove();
            this.cursorStates.set(tabKey, {
                ...state,
                circle: null,
            });
        }
    }

    destroy() {
        this.hideCursor();

        for (const tabKey of Array.from(this.cursorStates.keys())) {
            this.removeTabCursor(tabKey);
        }
        this.overlaySvg?.remove();
        this.overlayElement?.remove();
        this.overlayElement = null;
        this.overlaySvg = null;
        this.cursorStates.clear();

        this.previewElement?.removeEventListener(
            "scroll",
            this.onViewportChange,
        );
        this.previewElement = null as any;
        window.removeEventListener("resize", this.onViewportChange);
    }
}
