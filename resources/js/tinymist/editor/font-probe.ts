export class FontProbe {
    // Baseline fonts should be commonly available, but measurably distinct, we need a pair to compare against to detect fallbacks
    private static readonly FONT_ONE_VARIANTS = ["Arial","Verdana", "Times New Roman", "Palatino", "Helvetica"];
    private static readonly FONT_TWO_VARIANTS = ["Courier New", "Courier","Lucida Console", "Lucida Sans Typewriter"];
    private static readonly METRIC_SAMPLE = {
        xHeight: "xxxxxxxxxxxx",
        capHeight: "XXXXXXXXXXXX",
        emWidth: "mmmmmmmmmmmm",
        normalWidth: "nnnnnnnnnnnn",
    };
    private static readonly GENERIC_FONT_FAMILIES = new Set([
        "serif",
        "sans-serif",
        "monospace",
        "cursive",
        "fantasy",
        "system-ui",
        "emoji",
        "math",
        "fangsong",
        "ui-serif",
        "ui-sans-serif",
        "ui-monospace",
        "ui-rounded",
    ]);

    public static measureCanvas: HTMLCanvasElement | null = null;
    public static font1: { name: string; xHeight: number; capHeight: number; emWidth: number; normalWidth: number } | null = null;
    public static font2: { name: string; xHeight: number; capHeight: number; emWidth: number; normalWidth: number } | null = null;

    constructor() {
        this.defineCheckerFonts();
    }

    public static getMeasureContext(): CanvasRenderingContext2D | null {
        if (!FontProbe.measureCanvas) {
            FontProbe.measureCanvas = document.createElement("canvas");
        }
        return FontProbe.measureCanvas.getContext("2d");
    }

    /** Finding 2 distinct fonts that are not fallbacks and override each other if the order is swapped */
    private defineCheckerFonts(): void {
        const fonts_one  = FontProbe.FONT_ONE_VARIANTS;
        const fonts_two  = FontProbe.FONT_TWO_VARIANTS;
        const context = FontProbe.getMeasureContext();
        if (!context) {
            return;
        }

        for (let i = 0; i < fonts_one.length; i++) {
            const fontName1 = FontProbe.cleanFontCandidate(fonts_one[i]);
            for (let j = 0; j < fonts_two.length; j++) {
                const fontName2 = FontProbe.cleanFontCandidate(fonts_two[j]);
                const signature1 = FontProbe.measureTypographySignature(context, `"${fontName1}", "${fontName2}"`);
                const signature2 = FontProbe.measureTypographySignature(context, `"${fontName2}", "${fontName1}"`);
                if (signature1 && signature2 && !FontProbe.areSignaturesClose(signature1, signature2)) {
                    FontProbe.font1 = {name: fontName1, ...signature1};
                    FontProbe.font2 = {name: fontName2, ...signature2};
                    break;
                }
            }
            if (FontProbe.font1 && FontProbe.font2) {
                break;
            }
        }
    }

    public static getFontDistinctSignal(
        fontName: string,
    ): { label: string; className: string; } {
        // Generic is not the name of the font
        if (FontProbe.GENERIC_FONT_FAMILIES.has(fontName.toLowerCase())) {
            return { label: "generic", className: "is-generic" };
        }
        // In case it works in some environments or will work in the future
        const available = FontProbe.checkFontAvailability(fontName);
        if (available === false) {
            return { label: "not found", className: "is-missing" };
        }

        if (FontProbe.runDualBaselineFontTest(fontName)) {
            return { label: "available", className: "is-distinct" };
        }

        return { label: "not rendering", className: "is-unknown" };
    }

    /** If in both cases returned signature is the same, and we know that checker fonts are different
     * then we know that the engine didn't fall back to the checker fonts and fontName is rendering.
    */
    public static runDualBaselineFontTest(fontName: string): boolean {
        const context = FontProbe.getMeasureContext();
        if (!context || !this.font1 || !this.font2) {
            return false;
        }

        const testOne = FontProbe.measureTypographySignature(
            context,
            `"${fontName}", ${this.font1.name}`,
        );
        const testTwo = FontProbe.measureTypographySignature(
            context,
            `"${fontName}", ${this.font2.name}`,
        );

        return FontProbe.areSignaturesClose(testOne, testTwo);
    }

    public static measureTypographySignature(
        context: CanvasRenderingContext2D,
        fontFamily: string,
    ): {
        xHeight: number;
        capHeight: number;
        emWidth: number;
        normalWidth: number;
    } | null {
        const xMetrics = this.measureTextMetrics(context, fontFamily, FontProbe.METRIC_SAMPLE.xHeight);
        const capMetrics = this.measureTextMetrics(context, fontFamily, FontProbe.METRIC_SAMPLE.capHeight);
        const emMetrics = this.measureTextMetrics(context, fontFamily, FontProbe.METRIC_SAMPLE.emWidth);
        const normalMetrics = this.measureTextMetrics(context, fontFamily, FontProbe.METRIC_SAMPLE.normalWidth);

        if (!xMetrics || !capMetrics || !emMetrics || !normalMetrics) {
            return null;
        }

        const xCount = FontProbe.METRIC_SAMPLE.xHeight.length;
        const capCount = FontProbe.METRIC_SAMPLE.capHeight.length;
        const emCount = FontProbe.METRIC_SAMPLE.emWidth.length;
        const normalCount = FontProbe.METRIC_SAMPLE.normalWidth.length;

        return {
            xHeight: xMetrics.height,
            capHeight: capMetrics.height,
            emWidth: emMetrics.width / emCount,
            normalWidth: normalMetrics.width / normalCount,
        };
    }

    private static areSignaturesClose(
        first: { xHeight: number; capHeight: number; emWidth: number; normalWidth: number } | null,
        second: { xHeight: number; capHeight: number; emWidth: number; normalWidth: number } | null,
    ): boolean {
        if (!first || !second) {
            return false;
        }
        const maxHeightBase = Math.max(1, second.capHeight);
        const maxWidthBase = Math.max(1, second.emWidth);

        const xHeightDelta = Math.abs(first.xHeight - second.xHeight) / maxHeightBase;
        const capHeightDelta = Math.abs(first.capHeight - second.capHeight) / maxHeightBase;
        const emWidthDelta = Math.abs(first.emWidth - second.emWidth) / maxWidthBase;
        const normalWidthDelta = Math.abs(first.normalWidth - second.normalWidth) / maxWidthBase;

        const aggregateDelta = (xHeightDelta + capHeightDelta + emWidthDelta + normalWidthDelta) / 4;
        return aggregateDelta <= 0.02;
    }

    public static measureTextMetrics(
        context: CanvasRenderingContext2D,
        fontFamily: string,
        sample: string,
    ): { width: number; height: number } | null {
        context.font = `32px ${fontFamily}`;
        const metrics = context.measureText(sample);

        const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
            ? metrics.actualBoundingBoxAscent
            : 0;
        const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
            ? metrics.actualBoundingBoxDescent
            : 0;
        const height = Math.max(1, ascent + descent);

        if (!Number.isFinite(metrics.width) || metrics.width <= 0) {
            return null;
        }

        return {
            width: metrics.width,
            height,
        };
    }

    public static splitFontFamilyList(fontStack: string): string[] {
        if (!fontStack.trim()) {
            return [];
        }

        const parts: string[] = [];
        let current = "";
        let quote: string | null = null;

        for (let index = 0; index < fontStack.length; index++) {
            const character = fontStack[index];

            if ((character === '"' || character === "'") && (!quote || quote === character)) {
                quote = quote ? null : character;
                current += character;
                continue;
            }

            if (character === "," && !quote) {
                const cleaned = this.cleanFontCandidate(current);
                if (cleaned) {
                    parts.push(cleaned);
                }
                current = "";
                continue;
            }

            current += character;
        }

        const cleaned = this.cleanFontCandidate(current);
        if (cleaned) {
            parts.push(cleaned);
        }

        return parts;
    }

    public static cleanFontCandidate(candidate: string): string {
        return candidate.trim().replace(/^['"]|['"]$/g, "").trim();
    }

    public static checkFontAvailability(fontCandidate: string): boolean | null {
        if (!document.fonts?.check) {
            return null;
        }
        const normalized = FontProbe.cleanFontCandidate(fontCandidate);
        if (!normalized) {
            return false;
        }
        if (FontProbe.GENERIC_FONT_FAMILIES.has(normalized.toLowerCase())) {
            return true;
        }
        const escaped = normalized.replace(/"/g, '\\"');
        return document.fonts.check(`16px "${escaped}"`);
    }
}
