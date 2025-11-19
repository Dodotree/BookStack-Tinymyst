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
    cx: number;
    radius: number;
};

export class PreviewCursor {
    private previewElement: HTMLElement;
    private cursorCircle: SVGCircleElement | null = null;
    private cursorParams: CursorParams = { textSelector: 'svg.typst-doc>g.typst-group', charIndex: 0, cx: 0, radius: 0 };


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
    private pathToSelector(paths: any): void {
        const kindMap: Record<number, string> = {
            0: '.typst-text',  // g
            1: '.typst-group', // g
            2: '.typst-image', // ?
            3: '.typst-shape', // path
            4: '.typst-page',  // g
            5: 'use' // theoretically .tsel, but actually "use" tag
        };
        const validChildren = `>g.typst-group,>g.typst-text,>.typst-image,>.typst-shape,>g.typst-wrap`;

        this.cursorParams = paths.reduce((cursorMax: CursorParams, steps: any[]) => {

            let cx = 0;
            let radius = 0;

            const pairs: [string, number][] = steps.map((step: any) => [
                kindMap[Number(step.kind)] ?? '???',
                step.index + 1 // Convert to 1-based index for CSS
            ]);
            console.warn('[Preview WASM] pathToSelector pairs:', pairs);

            const pageStep = pairs.shift();
            const topGroupStep = pairs.shift();

            if (!pageStep || !topGroupStep) {
                console.warn('[Preview WASM] Invalid cursor path: insufficient steps');
                return cursorMax;
            }

            const topGroup = `svg.typst-doc > :nth-child(${pageStep[1]} of .typst-page)`
                + ` > :nth-child(${topGroupStep[1]} of :is(.typst-group,.typst-text,.typst-image,.typst-shape))`;

            let charStep = pairs.pop();
            if (!charStep || charStep[0] !== 'use') {
                if (charStep) {
                    pairs.push(charStep);
                }
                charStep = ['use', 1];
            }

            const textSelector = pairs.reduce((selector: string, [tag, child]: [string, number]) =>
                selector + `> :nth-child(${child} of :has(${validChildren}))>g`,
                topGroup);

            // For double data-tid wrappers not to get ignored / throw off indexing
            // Happens with rare shape paths
            document.querySelectorAll(`g[data-tid]:not([class])>[data-tid]:not([class]):has(${validChildren})`)
                .forEach(element => {
                    element.classList.add('typst-wrap');
                });
            console.debug('[Preview WASM] selector of the text node:', textSelector);
            console.debug('[Preview WASM] works?', document.querySelector(textSelector));

            const textNode = document.querySelector(textSelector);
            if (!textNode) {
                console.warn('[Preview WASM] Text node not found for selector:', textSelector);
                return cursorMax;
            }
            // append cursor circle, since svg is redrawn on every update, circle must be re-added
            const glyphNode = textNode.querySelector(`:nth-child(${charStep[1]} of use)`);
            // set cursor 'cx' attribute to match glyph 'x' attribute
            if (glyphNode) {
                cx = Number(glyphNode.getAttribute('x') || 0);
                const bbox = (glyphNode as SVGGraphicsElement).getBBox();
                radius = 2 * Math.max(bbox.height, bbox.width);
            }
            if (radius > cursorMax.radius!) {
                return { textSelector, charIndex: charStep[1], cx, radius };
            }
            return cursorMax;

            // Default selector stays if no larger radius found
        }, { textSelector: this.cursorParams.textSelector, charIndex: 0, cx: 0, radius: 0 } as CursorParams);

        this.showCursor();
    }

    /**
     * Show cursor circle at the specified glyph position
     */
    private showCursor(): void {
        const textNode = document.querySelector(this.cursorParams.textSelector);
        if (!textNode) return;

        // Remove old circle if it's attached to a different text node
        if (this.cursorCircle) {
            this.cursorCircle.remove();
        }

        // Create new circle
        this.cursorCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        this.cursorCircle.setAttribute('fill', '#66bab7');
        this.cursorCircle.setAttribute('fill-opacity', '0.25');
        this.cursorCircle.setAttribute('stroke', '#66bab7');
        this.cursorCircle.setAttribute('stroke-opacity', '0.65');
        this.cursorCircle.setAttribute('stroke-width', '1.5');
        this.cursorCircle.dataset.cursorIndicator = 'true';
        this.cursorCircle.style.pointerEvents = 'none';
        this.cursorCircle.style.transition = 'cx 0.1s ease, cy 0.1s ease, r 0.1s ease';

        // Append to text node
        textNode.appendChild(this.cursorCircle);

        // Update circle position
        this.cursorCircle.setAttribute('cx', this.cursorParams.cx.toFixed(2));
        this.cursorCircle.setAttribute('r', Math.max(5, this.cursorParams.radius).toFixed(2));
    }

    dispose() {
        this.cursorCircle?.remove();
        this.cursorCircle = null;

        console.log("[Preview WASM] Renderer disposed");
    }

}
