// This is visualization for cursor positions in the preview pane
// Request for its position are initiated from:
// 1) backend preview_server when Data Plane receives new/diff-v1 updates
// 2) explicitly requested by editor->preview_ws(control plane) on clicks/cursor moves

// Gets cursorPaths from preview websocket
// queries the current svg.typst-doc to match cursor paths
// appends cursor circles to those elements
// keeps the state so that svg re-renders can re-apply the cursor positions

import {
    tmClassNames, tmEvents, tmSelectors,
    LIGHT_OWNER_CURSOR_COLOR,
    LIGHT_UNKNOWN_CURSOR_COLOR,
    LIGHT_REMOTE_CURSOR_COLORS,
    DARK_OWNER_CURSOR_COLOR,
    DARK_UNKNOWN_CURSOR_COLOR,
    DARK_REMOTE_CURSOR_COLORS,
} from "../constants";

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

export class PreviewCursor {
    private readonly uniqueTabId: string;
    private spotlightEnabled: boolean = true;

    private latestCursorRequesterTabId: string = "";
    private cursorStates = new Map<string, CursorState>();

    constructor(uniqueTabId?: string) {
        this.uniqueTabId = uniqueTabId || "";

        this.destroy = this.destroy.bind(this);
        this.pathToSelector = this.pathToSelector.bind(this);
        this.showCursors = this.showCursors.bind(this);
        this.showCursorsWithoutEmit = this.showCursorsWithoutEmit.bind(this);

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

        window.$tmEventBus.listen(tmEvents.DataCursorShow, this.showCursors);
        window.$tmEventBus.listen(
            tmEvents.CursorSpotlightToggle,
            ({ enabled }: { enabled?: boolean }) => {
                this.spotlightEnabled = Boolean(enabled);
                if (!this.spotlightEnabled) {
                    this.hideCursor();
                } else {
                    this.showCursorsWithoutEmit();
                }
            },
        );
        window.$tmEventBus.listen(tmEvents.Destroy, this.destroy);

        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        previewElement.addEventListener("scroll", this.showCursorsWithoutEmit, {
            passive: true,
        });
        window.addEventListener("resize", this.showCursorsWithoutEmit, {
            passive: true,
        });
    }

    private ensureOverlay(): SVGSVGElement | null {
        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        let overlaySvg = previewElement.querySelector(
            `${tmSelectors.PreviewCursorOverlay} > svg`,
        ) as SVGSVGElement | null;

        if (overlaySvg) {
            return overlaySvg;
        }

        if (getComputedStyle(previewElement).position === "static") {
            previewElement.style.position = "relative";
        }

        const overlayElement = document.createElement("div");
        overlayElement.className = tmClassNames.PreviewCursorOverlay;
        Object.assign(overlayElement.style, {
            position: "absolute",
            inset: "0",
            pointerEvents: "none",
            zIndex: "10",
        });

        overlaySvg = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
        );
        overlaySvg.setAttribute("width", "100%");
        overlaySvg.setAttribute("height", "100%");
        overlaySvg.style.overflow = "visible";

        overlayElement.appendChild(overlaySvg);
        previewElement.appendChild(overlayElement);
        return overlaySvg;
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
        const darkMode = this.isDarkMode();
        const ownerColor = darkMode
            ? DARK_OWNER_CURSOR_COLOR
            : LIGHT_OWNER_CURSOR_COLOR;
        const unknownColor = darkMode
            ? DARK_UNKNOWN_CURSOR_COLOR
            : LIGHT_UNKNOWN_CURSOR_COLOR;
        const remotePalette = darkMode
            ? DARK_REMOTE_CURSOR_COLORS
            : LIGHT_REMOTE_CURSOR_COLORS;

        if (tabKey === UNKNOWN_TAB_KEY) {
            return unknownColor;
        }
        if (this.isOwnerTab(tabKey)) {
            return ownerColor;
        }

        let hash = 0;
        for (let index = 0; index < tabKey.length; index++) {
            hash = (hash * 31 + tabKey.charCodeAt(index)) >>> 0;
        }
        return remotePalette[hash % remotePalette.length];
    }

    private isDarkMode(): boolean {
        if (document.documentElement.classList.contains("dark-mode")) {
            return true;
        }
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
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

    private showCursorsWithoutEmit(): void {
        this.showAllCursors(false);
    }

    private showCursors(emitPosition: boolean = true): void {
        this.showAllCursors(emitPosition);
    }

    private showAllCursors(emitOwnerPosition: boolean = true): void {
        if (!this.spotlightEnabled) {
            this.hideCursor();
            return;
        }

        const overlaySvg = this.ensureOverlay();
        if (!overlaySvg) {
            return;
        }

        this.pruneStaleCursors();
        const overlayRect = overlaySvg.getBoundingClientRect();

        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        const previewRect = previewElement.getBoundingClientRect();
        const scrollLeft = previewElement.scrollLeft;
        const scrollTop = previewElement.scrollTop;

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
                overlaySvg.appendChild(state.circle);
            }

            const glyphRect = glyphNode.getBoundingClientRect();
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
                scrollLeft +
                glyphRect.width / 2;
            const contentY =
                glyphRect.top -
                previewRect.top +
                scrollTop +
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
        this.cursorStates.clear();

        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        previewElement?.removeEventListener(
            "scroll",
            this.showCursorsWithoutEmit
        );

        window.removeEventListener("resize", this.showCursorsWithoutEmit);
    }
}
