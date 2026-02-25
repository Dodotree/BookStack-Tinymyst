// This is visualization for cursor positions in the preview pane
// Request for its position are initiated from:
// 1) backend preview_server when Data Plane receives new/diff-v1 updates
// 2) explicitly requested by editor->preview_ws(control plane) on clicks/cursor moves

// Gets cursorPaths from preview websocket
// queries the current svg.typst-doc to match cursor paths
// appends cursor circles to those elements
// keeps the state so that svg re-renders can re-apply the cursor positions

type CursorParams = {
    textSelector: string;
    charIndex: number;
};

export class PreviewCursor {
    private previewElement: HTMLElement;
    private overlayElement: HTMLDivElement | null = null;
    private overlaySvg: SVGSVGElement | null = null;
    private cursorCircle: SVGCircleElement | null = null;
    private cursorParams: CursorParams = { textSelector: 'svg.typst-doc>g.typst-group', charIndex: 0 };
    private onViewportChange: () => void;
    private spotlightEnabled = true;


    constructor(
        previewElement: HTMLElement,
    ) {
        this.previewElement = previewElement;

        this.dispose = this.dispose.bind(this);
        this.pathToSelector = this.pathToSelector.bind(this);
        this.showCursor = this.showCursor.bind(this);
        window.$events.listen("tinymist-wasm-dispose", this.dispose);
        window.$events.listen("tinymist-data-cursor-paths", this.pathToSelector);
        window.$events.listen("tinymist-data-cursor-show", this.showCursor);
        window.$events.listen("tinymist-cursor-spotlight-toggle", ({ enabled }: { enabled?: boolean }) => {
            this.spotlightEnabled = Boolean(enabled);
            if (!this.spotlightEnabled) {
                this.hideCursor();
            } else {
                this.showCursor();
            }
        });

        this.onViewportChange = this.showCursor.bind(this);
        this.previewElement.addEventListener('scroll', this.onViewportChange, { passive: true });
        window.addEventListener('resize', this.onViewportChange, { passive: true });
    }

    private ensureOverlay(): void {
        if (this.overlayElement && this.overlaySvg) return;

        if (getComputedStyle(this.previewElement).position === 'static') {
            this.previewElement.style.position = 'relative';
        }

        this.overlayElement = document.createElement('div');
        this.overlayElement.className = 'tinymist-cursor-overlay';
        Object.assign(this.overlayElement.style, {
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none',
            zIndex: '10'
        });

        this.overlaySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.overlaySvg.setAttribute('width', '100%');
        this.overlaySvg.setAttribute('height', '100%');
        this.overlaySvg.style.overflow = 'visible';

        this.overlayElement.appendChild(this.overlaySvg);
        this.previewElement.appendChild(this.overlayElement);
    }

    /**
     * * * * * CssClassToType
     * ["typst-text", SourceMappingType.Text],
     * ["typst-group", SourceMappingType.Group],
     * ["typst-image", SourceMappingType.Image],
     * ["typst-shape", SourceMappingType.Shape],
     * ["typst-page", SourceMappingType.Page],
     * ["tsel", SourceMappingType.CharIndex],
     *
     * SVG Structure Notes:
     * svg.typst-doc
     *  > g.typst-page (one per page)
     *    > g data-tid="..." (data-tid wrappers)
     *      > g.typst-group (frames, groups)
     *        > g data-tid="..." (data-tid wrappers)
     *          > g.typst-text (text blocks)
     *            > use (glyphs)
     * Every group except the first one is wrapped in a data-tid element.
     * Cursor paths count only mentioned below elements as children
     * ${n} is 1-based index
     * `svg.typst-doc > :nth-child(${n} of .typst-page)` is a starting point
     * `> :nth-child(${n} of :is(.typst-group,.typst-text))` first element in the page
     *  followed by data-tid wrapper for the 12th group and the group itself
     * :is() and :has() should have all allowed child types (except typst-page)
     * `> :nth-child(${n} of g:has(>g.typst-group,>g.typst-text, ...))>g`
     *  repeats for nested groups until text g.typst-text
     *  > :nth-child(${n} of g:has(>g.typst-group,>g.typst-text, ...))>g> :nth-child(${n} of use)
     *
     * The g.typst-text element is where we will append the cursor svg circle.
     * And we should copy "x" from "use" element to "cx" of the circle.
     *
     * Path format notes:
     *
     * Nested data-tid without class can throw off indexing, handled for 2 levels (for now)
     *
     * Usually cursor paths have only 1 path [[]]
     * Code blocks give extra paths [[],[],[],[],[]]
     * "occur when a single source-code cursor position maps to multiple rendered elements"
     * Put a circle at each resolved node of not 0 bounding box
     *
     * Cursor Paths are not provided for $infinity$ and functions like #datetime.today()
     */

    /*
    data-tid is the SVG element identity used by the incremental SVG patcher. It’s typically a content hash (with a suffix if not unique) and is used to compare/reuse <g> elements when applying diffs; see patch.mts:9-33. The renderer attaches it when emitting SVG nodes (e.g., render_item_at) in mod.rs:496-506 data-tid is attached to SVG nodes that correspond to vector items (Fingerprint-backed content) during rendering. That includes pages/groups/items that exist as real render nodes; see mod.rs:496-506. Structural SVG nodes like defs, style, clipPath, or empty branches that don’t map to a vector item typically won’t have data-tid. *** But ".typst-content-hint" have them *** -- so it's not a useful selector for typst path after all.
    ".typst-content-hint" usually only has data-hint="a" which means hex 0a "new line" and is before heading node

    svg.typst-doc > :nth-child(1 of .typst-page) > :nth-child(1 of [data-tid])> :nth-child(14 of :has(>g>:not(g:empty))

    Interestingly fingerprints are hardcoded to be empty Span2VecPass::query_element_paths (every ElementPoint uses fingerprint: "".to_owned() (unless you rewrite it)
    */

    /*
    data-spans contain source-code, their span id is a hex string of the same "span" provided by the outline.
    would be nice to have them, maybe they existed some time ago with debugging enabled?
    but currently source code mapping is not emitted by tinymist and there are no functions to insert them in the renderer
        const el = (e.target as Element).closest('[data-span]') as Element | null;
        if (!el) return;
        const spanHex = el.getAttribute('data-span')!;

        // cursorPath from tinymist: [kind0, index0, kind1, index1, ...]
        const cursorPath = [4, 0, 1, 3, 0, 12]; // sample
        const path = new Uint32Array(cursorPath);
        const loc = session.getSourceLoc(path);
        console.debug(loc); // e.g. "1f2a3b4c" (span id as hex) or undefined
    */

    private pathToSelector(paths: any): void {
        if (!this.spotlightEnabled) {
            return;
        }
        const kindMap: Record<number, string> = {
            0: '.typst-text',  // g
            1: '.typst-group', // g
            2: '.typst-image', // ?
            3: '.typst-shape', // path
            4: '.typst-page',  // g
            5: 'use' // theoretically .tsel, but actually "use" tag
        };
        // const validChildren = `>g.typst-group,>g.typst-text,>.typst-image,>.typst-shape,>g.typst-wrap`;

        this.cursorParams = paths.reduce((cursorMax: CursorParams, steps: any[]) => {

            const pairs: [string, number][] = steps.map((step: any) => [
                kindMap[Number(step.kind)] ?? '???',
                step.index + 1 // Convert to 1-based index for CSS
            ]);
            // console.debug('[Preview WASM] pathToSelector pairs:', pairs);

            const pageStep = pairs.shift();
            const topGroupStep = pairs.shift();

            if (!pageStep || !topGroupStep) {
                console.warn('[Preview WASM] Invalid cursor path: insufficient steps');
                return cursorMax;
            }

            const topGroup = `svg.typst-doc > :nth-child(${pageStep[1]} of .typst-page)`
                + ` > :nth-child(${topGroupStep[1]} of [data-tid])`;
                // + ` > :nth-child(${topGroupStep[1]} of :is(.typst-group,.typst-text,.typst-image,.typst-shape))`;

            let charStep = pairs.pop();
            if (!charStep || charStep[0] !== 'use') {
                if (charStep) {
                    pairs.push(charStep);
                }
                charStep = ['use', 1];
            }

            const textSelector = pairs.reduce((selector: string, [tag, child]: [string, number]) =>
                selector + `> :nth-child(${child} of :has(>g>:not(g:empty)))>g`,
                topGroup);

            // For double data-tid wrappers not to get ignored / throw off indexing
            // Happens with rare shape paths
            // document.querySelectorAll(`g[data-tid]:not([class])>[data-tid]:not([class]):has(${validChildren})`)
            //     .forEach(element => {
            //         element.classList.add('typst-wrap');
            //     });
            // console.debug('[Preview WASM] selector of the text node:', textSelector);
            const textNode = document.querySelector(textSelector);
            // console.debug('[Preview WASM] works?', textNode);

            if (!textNode) {
                console.warn('[Preview WASM] Text node not found for selector:', textSelector);
                return cursorMax;
            }
            return { textSelector, charIndex: charStep[1] };

        }, { textSelector: this.cursorParams.textSelector, charIndex: 0 } as CursorParams);

        this.showCursor();
    }

    /**
     * Show cursor circle at the specified glyph position
     */
    private showCursor(): void {
        if (!this.spotlightEnabled) {
            this.hideCursor();
            return;
        }
        // console.debug('[Preview WASM] showCursor with params:', this.cursorParams, this.overlaySvg, 'cursorCircle exists:', !!this.cursorCircle);

        const textNode = document.querySelector(this.cursorParams.textSelector);
        if (!textNode) return;

        // console.debug(`[Preview WASM] text char ${this.cursorParams.charIndex}`, textNode);

        const glyphNode = textNode.querySelector(`:nth-child(${this.cursorParams.charIndex} of use,path)`) as SVGGraphicsElement | null;
        if (!glyphNode) return;

        // console.debug('[Preview WASM] glyph node for cursor:', glyphNode);

        this.ensureOverlay();

        if (!this.overlaySvg) return;

        if (!this.cursorCircle) {
            this.cursorCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            this.cursorCircle.setAttribute('fill', '#66bab7');
            this.cursorCircle.setAttribute('fill-opacity', '0.25');
            this.cursorCircle.setAttribute('stroke', '#66bab7');
            this.cursorCircle.setAttribute('stroke-opacity', '0.65');
            this.cursorCircle.setAttribute('stroke-width', '1.5');
            this.cursorCircle.dataset.cursorIndicator = 'true';
            this.cursorCircle.style.pointerEvents = 'none';
            this.cursorCircle.style.transition = 'cx 0.1s ease, cy 0.1s ease, r 0.1s ease';
            this.overlaySvg.appendChild(this.cursorCircle);
        }

        const glyphRect = glyphNode.getBoundingClientRect();
        const overlayRect = this.overlaySvg.getBoundingClientRect();
        const previewRect = this.previewElement.getBoundingClientRect();

        const cx = glyphRect.left - overlayRect.left + glyphRect.width / 2;
        const cy = glyphRect.top - overlayRect.top + glyphRect.height / 2;
        const r = Math.min(30, Math.max(15, Math.max(glyphRect.width, glyphRect.height) / 2));
        // console.debug(`[Preview WASM] glyphRect:`, glyphRect, `overlayRect:`, overlayRect, `calculated cx: ${cx}, cy: ${cy}, r: ${r}`);

        // Update circle position
        this.cursorCircle.setAttribute('cx', cx.toFixed(2));
        this.cursorCircle.setAttribute('cy', cy.toFixed(2));
        this.cursorCircle.setAttribute('r', r.toFixed(2));

        const contentX = glyphRect.left - previewRect.left + this.previewElement.scrollLeft + glyphRect.width / 2;
        const contentY = glyphRect.top - previewRect.top + this.previewElement.scrollTop + glyphRect.height / 2;
        window.$events.emit("tinymist-preview-cursor-position", {
            contentX,
            contentY,
            width: glyphRect.width,
            height: glyphRect.height,
        });
    }

    private hideCursor(): void {
        if (!this.cursorCircle) {
            return;
        }
        this.cursorCircle.remove();
        this.cursorCircle = null;
    }

    dispose() {
        this.hideCursor();

        this.overlayElement?.remove();
        this.overlayElement = null;
        this.overlaySvg = null;
        this.previewElement.removeEventListener('scroll', this.onViewportChange);
        window.removeEventListener('resize', this.onViewportChange);

        // console.debug("[Preview WASM] Cursor disposed");
    }

}
