// reconstruction of typst.svg.gs which WASM appends to rendered SVG by default

const ignoredEvent = function () {
  const history: Record<string, number> = {};
  let lastDiff: number | undefined;
  let lastTime: number;

  return function (callback: () => void, delay: number, id?: string) {
    lastTime = new Date().getTime();
    id = id || "ignored event";
    lastDiff = history[id] ? lastTime - history[id] : lastTime;
    if (lastDiff > delay) {
      history[id] = lastTime;
      callback();
    }
  };
}();

const fc = <T>(array: ArrayLike<T>, predicate: (value: T) => boolean): T[] => {
  const results: T[] = [];
  for (let idx = 0; idx < array.length; idx++) {
    const entry = array[idx];
    if (predicate(entry)) {
      results.push(entry);
    }
  }
  return results;
};

const overLappingDom = (a: DOMRect, b: DOMRect): boolean => {
  return !(
    a.right < b.left ||
    a.left > b.right ||
    a.bottom < b.top ||
    a.top > b.bottom
  );
};

const almostOverLapping = (a: Element, b: Element): boolean => {
  const rectA = a.getBoundingClientRect();
  const rectB = b.getBoundingClientRect();

  return (
    overLappingDom(rectA, rectB) &&
    (Math.abs(rectA.left - rectB.left) + Math.abs(rectA.right - rectB.right)) /
      Math.max(rectA.width, rectB.width) <
      0.5 &&
    (Math.abs(rectA.bottom - rectB.bottom) + Math.abs(rectA.top - rectB.top)) /
      Math.max(rectA.height, rectB.height) <
      0.5
  );
};

export const gr = (window.typstGetRelatedElements = (element: Element) => {
  let related = (element as any).relatedElements as Element[] | undefined;
  if (related == null) {
    related = (element as any).relatedElements = searchIntersections(element);
  }
  return related;
});

const getRelatedElements = (event: Event & { target: Element }) => gr(event.target);

function findAncestor<T extends Element>(element: T | null, cls: string): Element | null {
  while (element && !element.classList.contains(cls)) {
    element = element.parentElement as T | null;
  }
  return element;
}

function findGlyphListForText(element: Element): Element[] | undefined {
  const parent = findAncestor(element, "typst-text");
  return parent ? fc(parent.children, child => child.tagName === "use") : undefined;
}

const searchIntersections = (element: Element): Element[] | undefined => {
  const parent = findAncestor(element, "typst-group");
  return parent ? fc(parent.children, child => almostOverLapping(child, element)) : undefined;
};

function nextNode(node: Node | null): Node | null {
  if (!node) {
    return null;
  }
  if (node.hasChildNodes()) {
    return node.firstChild;
  }
  while (node && !node.nextSibling) {
    node = node.parentNode;
  }
  return node ? node.nextSibling : null;
}

function getRangeSelectedNodes(range: Range, predicate: (node: Node | Element) => boolean): (Node | Element)[] {
  const { startContainer, endContainer } = range;
  if (startContainer === endContainer) {
    if (predicate(startContainer)) {
      return [startContainer];
    }
    if (predicate(startContainer.parentElement!)) {
      return [startContainer.parentElement!];
    }
  }

  const result: (Node | Element)[] = [];
  let current: Node | null = startContainer;
  while (current && current !== endContainer) {
    current = nextNode(current);
    if (current && predicate(current)) {
      result.push(current);
    }
  }

  current = startContainer;
  while (current && current !== range.commonAncestorContainer) {
    if (predicate(current)) {
      result.unshift(current);
    }
    current = current.parentNode;
  }

  return result;
}

function getSelectedNodes(predicate: (node: Element) => boolean): Element[] {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return [];
  }

  if (selection.rangeCount === 1) {
    return getRangeSelectedNodes(selection.getRangeAt(0), predicate) as Element[];
  }

  const results: Element[] = [];
  for (let idx = 0; idx < selection.rangeCount; idx++) {
    results.push(...(getRangeSelectedNodes(selection.getRangeAt(idx), predicate) as Element[]));
  }
  return results;
}

function getGlyphLenShape(nodes: Element[]): number[] {
  return nodes.map(node => {
    const href = node.getAttribute("href");
    if (!href) {
      return 1;
    }
    const target = document.getElementById(href.slice(1));
    const ligaLen = target?.getAttribute("data-liga-len");
    return 1 + Number.parseInt(ligaLen || "0");
  });
}

function getGlyphAdvanceShape(nodes: Element[]): number[] {
  return nodes.map(node => Number.parseInt(node.getAttribute("x") || "0"));
}

function adjustTextSelection(root: Element, flow: { flow: Element[] }) {
  root.addEventListener("copy", event => {
    const chunks = getSelectedNodes(node =>
      node.classList?.contains("tsel") ||
      node.classList?.contains("tsel-tok") ||
      node.classList?.contains("typst-content-hint")
    );

    const pieces: string[] = [];
    let hadText = false;

    for (const chunk of chunks) {
      if (chunk.classList.contains("tsel")) {
        if (!chunk.hasAttribute("data-typst-layout-checked")) {
          pieces.push(chunk.textContent ?? "");
        }
        hadText = true;
        continue;
      }

      if (chunk.classList.contains("tsel-tok")) {
        pieces.push(chunk.textContent ?? "");
        continue;
      }

      if (hadText) {
        const hint = chunk.getAttribute("data-hint");
        const codePoint = hint ? Number.parseInt(hint, 16) : 0;
        pieces.push(String.fromCodePoint(codePoint) || "\n");
        hadText = true;
      }
    }

    const text = pieces.join("").replace(/\u00a0/g, " ");
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text);
    } else {
      event.clipboardData?.setData("text/plain", text);
    }
    event.preventDefault();
  });

  const toElement = (node: Node | Element): Element | undefined =>
    node.nodeType === Node.TEXT_NODE ? node.parentElement ?? undefined : (node as Element);

  const toCell = (node: Node | Element): Element | undefined => {
    const element = toElement(node);
    return element?.classList?.contains("tsel") ? element : undefined;
  };

  const renderBox = (rect: DOMRect): string =>
    `<div style="position: absolute; float: left; left: ${rect.left + window.scrollX}px; top: ${rect.top + window.scrollY}px; width: ${rect.width}px; height: ${rect.height}px; background-color: #7db9dea0;"></div>`;

  const clearOverlay = (overlay?: HTMLElement | null) => {
    if (overlay) {
      overlay.innerHTML = "";
    }
  };

  let dragActive = false;
  window.addEventListener("mousedown", evt => {
    if (evt.button === 0) {
      dragActive = true;
    }
  });
  window.addEventListener("mouseup", evt => {
    if (evt.button === 0) {
      dragActive = false;
    }
  });

  root.addEventListener("mousemove", evt => {
    if (!dragActive) {
      return;
    }
    ignoredEvent(() => {
      highlightSelection(evt);
    }, 2, "doc-text-sel");
  });

  function highlightSelection(evt?: MouseEvent) {
    const selection = window.getSelection();
    let overlay = document.getElementById("tsel-sel-box");

    if (!selection?.rangeCount) {
      clearOverlay(overlay as HTMLElement | null);
      return;
    }

    const firstRange = selection.getRangeAt(0);
    const lastRange = selection.getRangeAt(selection.rangeCount - 1);
    if (!firstRange || !lastRange) {
      return;
    }

    const skip = (node: Node | Element | null) =>
      node?.classList?.contains("text-guard") ||
      node?.classList?.contains("typst-page") ||
      node?.classList?.contains("typst-search-hint");

    const first = skip(toElement(firstRange.startContainer));
    const last = skip(toElement(lastRange.endContainer));

    if (first || last) {
      if (first && last) {
        clearOverlay(overlay as HTMLElement | null);
      }
      return;
    }

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "tsel-sel-box";
      overlay.style.zIndex = "100";
      overlay.style.position = "absolute";
      overlay.style.pointerEvents = "none";
      overlay.style.left = "0";
      overlay.style.top = "0";
      overlay.style.float = "left";
      document.body.appendChild(overlay);
    }

    const firstCell = toCell(firstRange.startContainer);
    const lastCell = toCell(lastRange.endContainer);

    const selected = getSelectedNodes(node =>
      node.classList?.contains("tsel") ||
      node.classList?.contains("typst-search-hint") ||
      node.classList?.contains("tsel-tok")
    );

    const tmpRange = new Range();
    const overlays: string[] = [];
    const pushOverlay = (startNode: Element, endNode: Element) => {
      tmpRange.setStartBefore(startNode);
      tmpRange.setEndAfter(endNode);
      overlays.push(renderBox(tmpRange.getBoundingClientRect()));
    };

    const blocks = new Map<Element, [number, number]>();

    for (const node of selected) {
      if (node.classList.contains("tsel-tok")) {
        const parent = node.parentElement!;
        const idx = Array.from(parent.children).indexOf(node);
        const range = blocks.get(parent);
        if (!range) {
          blocks.set(parent, [idx, idx]);
        } else {
          range[0] = Math.min(range[0], idx);
          range[1] = Math.max(range[1], idx);
        }
        continue;
      }

      if (node.classList.contains("tsel") && !node.hasAttribute("data-typst-layout-checked")) {
        const start = node === firstCell ? firstRange.startOffset : 0;
        const end = node === lastCell ? lastRange.endOffset - 1 : -1;
        blocks.set(node, [start, end]);
      }
    }

    if (evt) {
      let minIdx = Number.POSITIVE_INFINITY;
      let maxIdx = -1;
      for (const key of blocks.keys()) {
        const indexAttr = key.getAttribute("data-selection-index");
        if (!indexAttr) {
          continue;
        }
        const numeric = Number.parseInt(indexAttr);
        minIdx = Math.min(minIdx, numeric);
        maxIdx = Math.max(maxIdx, numeric);
      }
      if (maxIdx !== -1) {
        const clientX = evt.clientX;
        const clientY = evt.clientY;
        const flowList = flow.flow;
        while (true) {
          const block = flowList[maxIdx];
          const rect = block.getBoundingClientRect();
          if ((clientX > rect.right || clientY > rect.bottom) && maxIdx + 1 < flowList.length) {
            blocks.set(block, [0, -1]);
            maxIdx += 1;
            const nextRect = flowList[maxIdx].getBoundingClientRect();
            if (rect.bottom > nextRect.top && rect.top < nextRect.bottom) {
              continue;
            }
          }
          break;
        }
      }
    }

    for (const [node, [startIdx, endIdx]] of blocks) {
      const glyphs = findGlyphListForText(node);
      if (!glyphs?.length) {
        continue;
      }

      if (startIdx === 0 && endIdx === -1) {
        pushOverlay(glyphs[0], glyphs[glyphs.length - 1]);
        continue;
      }

      const lenShape = getGlyphLenShape(glyphs);
      const seekGlyph = (position: number) => {
        let offset = 0;
        for (let idx = 0; idx < lenShape.length; idx++) {
          if (offset + lenShape[idx] > position) {
            return glyphs[idx];
          }
          offset += lenShape[idx];
        }
        return glyphs[0];
      };

      let startNode = glyphs[0];
      if (startIdx !== 0) {
        startNode = seekGlyph(startIdx) || startNode;
      }

      let endNode = glyphs[glyphs.length - 1];
      if (endIdx !== -1) {
        endNode = seekGlyph(endIdx) || endNode;
      }

      pushOverlay(startNode, endNode);
    }

    overlay.innerHTML = overlays.join("");
  }
}

function createPseudoText(cls: string): SVGForeignObjectElement {
  const foreign = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
  foreign.setAttribute("width", "1");
  foreign.setAttribute("height", "1");
  foreign.setAttribute("x", "0");
  foreign.setAttribute("y", "0");

  const span = document.createElement("span");
  span.textContent = "&nbsp;";
  span.style.width = span.style.height = "100%";
  span.style.textAlign = "justify";
  span.style.opacity = "0";
  span.classList.add(cls);
  foreign.append(span);
  return foreign;
}

const linkmove = (evt: MouseEvent) =>
  ignoredEvent(() => getRelatedElements(evt)?.forEach(element => element.classList.add("hover")), 200, "mouse-move");

const linkleave = (evt: MouseEvent) =>
  getRelatedElements(evt)?.forEach(element => element.classList.remove("hover"));

window.typstProcessSvg = function (docRoot: SVGElement, options?: { layoutText?: boolean }) {
  const layoutContext = { flow: [] as Element[] };

  const pseudoLinks = docRoot.getElementsByClassName("pseudo-link");
  for (let idx = 0; idx < pseudoLinks.length; idx++) {
    const anchor = pseudoLinks[idx] as SVGAElement;
    anchor.addEventListener("mousemove", linkmove);
    anchor.addEventListener("mouseleave", linkleave);
  }

  const enableLayout = options?.layoutText ?? true;
  if (enableLayout) {
    setTimeout(() => {
      const style = document.createElement("style");
      style.innerHTML = `.tsel { font-family: monospace; text-align-last: left !important; -moz-text-size-adjust: none; -webkit-text-size-adjust: none; text-size-adjust: none; }
.tsel span { float: left !important; position: absolute !important; width: fit-content !important; top: 0 !important; }
.typst-search-hint { font-size: 2048px; color: transparent; width: 100%; height: 100%; }
.typst-search-hint { color: transparent; user-select: none; }
.typst-search-hint::-moz-selection { color: transparent; background: #00000001; }
.typst-search-hint::selection { color: transparent; background: #00000001; }
.tsel span::-moz-selection,
.tsel::-moz-selection {
  background: transparent !important;
}
.tsel span::selection,
.tsel::selection {
  background: transparent !important;
}`;
      document.getElementsByTagName("head")[0].appendChild(style);

      const pixelRatio = window.devicePixelRatio || 1;
      docRoot.style.setProperty("--typst-font-scale", pixelRatio.toString());
      window.addEventListener("resize", () => {
        const ratio = window.devicePixelRatio || 1;
        docRoot.style.setProperty("--typst-font-scale", ratio.toString());
      });

      window.layoutText(docRoot, layoutContext);
    }, 0);

    adjustTextSelection(docRoot, layoutContext);
  }

  docRoot.addEventListener("click", evt => {
    let target: Element | null = evt.target as Element | null;
    while (target) {
      const span = target.getAttribute("data-span");
      if (span) {
        console.log("source-span of this svg element", span);
        const body = document.body || document.firstElementChild!;
        const bounds = body.getBoundingClientRect();
        const width = window.innerWidth || 0;
        const left = evt.clientX - bounds.left + 0.015 * width;
        const top = evt.clientY - bounds.top + 0.015 * width;
        triggerRipple(body, left, top, "typst-debug-react-ripple", "typst-debug-react-ripple-effect .4s linear");
        return;
      }
      target = target.parentElement;
    }
  });

  if (enableLayout) {
    docRoot.querySelectorAll(".typst-page").forEach(page => {
      page.prepend(createPseudoText("text-guard"));
    });
  }

  if (window.location.hash) {
    const parts = window.location.hash.split("-");
    if (parts.length === 2 && parts[0] === "#loc") {
      const fields = parts[1].split("x");
      if (fields.length === 3) {
        const page = Number.parseInt(fields[0]);
        const x = Number.parseFloat(fields[1]);
        const y = Number.parseFloat(fields[2]);
        window.handleTypstLocation(docRoot, page, x, y);
      }
    }
  }
};

window.layoutText = function (docRoot: SVGElement, context: { flow: Element[] }) {
  const cells = Array.from(docRoot.querySelectorAll<HTMLElement>(".tsel"));
  context.flow = cells;

  const begin = performance.now();
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "128px sans-serif";
  const glyphWidth = ctx.measureText("A").width;

  const snapshots: Array<[HTMLElement, string]> = [];
  const processSlice = (start: number, end: number) => {
    const slice = cells.slice(start, end);
    start -= 1;
    for (const cell of slice) {
      start += 1;
      if (cell.getAttribute("data-typst-layout-checked")) {
        continue;
      }

      cell.setAttribute("data-selection-index", start.toString());
      cell.setAttribute("data-typst-layout-checked", "1");

      if (!cell.style.fontSize) {
        continue;
      }

      const parent = cell.parentElement!;
      const text = cell.innerText;
      const copy = parent.cloneNode(true) as HTMLElement;
      const firstChild = copy.firstElementChild as HTMLElement | null;
      if (firstChild) {
        firstChild.className = "typst-search-hint";
      }
      parent.parentElement!.insertBefore(copy, parent);
      snapshots.push([cell, text]);

      const glyphs = findGlyphListForText(cell);
      if (!glyphs) {
        continue;
      }

      const lenShape = getGlyphLenShape(glyphs);
      const advances = getGlyphAdvanceShape(glyphs).map(px => px / 16);

      let clipped = false;
      const spans: HTMLElement[] = [];
      let glyphIdx = 0;
      let ligatureOffset = 0;
      for (const ch of text) {
        if (glyphIdx >= advances.length) {
          clipped = true;
          break;
        }

        let left = advances[glyphIdx];
        if (lenShape[glyphIdx] > 1) {
          left += ligatureOffset * glyphWidth;
        }

        ligatureOffset += 1;
        if (ligatureOffset >= lenShape[glyphIdx]) {
          glyphIdx += 1;
          ligatureOffset = 0;
        }

        const span = document.createElement("span");
        span.textContent = ch;
        span.classList.add("tsel-tok");
        span.style.left = `${left}px`;
        spans.push(span);
      }

      if (clipped) {
        continue;
      }

      cell.innerHTML = "";
      cell.append(...spans);
    }

    console.log(`layoutText ${cells.length} elements used since ${performance.now() - begin} ms`);
  };

  const batchSize = 100;
  for (let idx = 0; idx < cells.length; idx += batchSize) {
    const start = idx;
    setTimeout(() => {
      processSlice(start, start + batchSize);
    });
  }
};

window.handleTypstLocation = function (
  docRoot: Element,
  pageNumber: number,
  posX: number,
  posY: number,
  options?: { behavior?: ScrollBehavior }
) {
  const behavior = options?.behavior || "smooth";
  const assignHash = window.assignSemaHash || ((page: number, x: number, y: number) => {
    location.hash = `loc-${page}x${x.toFixed(2)}x${y.toFixed(2)}`;
  });

  const container = findAncestor(docRoot, "typst-doc");
  if (!container) {
    console.warn("no typst-doc found", docRoot);
    return;
  }

  const pages = container.children;
  let index = 0;
  for (let idx = 0; idx < pages.length; idx++) {
    if (pages[idx].tagName === "g") {
      index += 1;
    }
    if (index === pageNumber) {
      const marginX = window.innerWidth * 0.01;
      const marginY = window.innerHeight * 0.01;
      const page = pages[idx] as SVGGElement;
      const totalWidth = Number.parseFloat(container.getAttribute("data-width") || container.getAttribute("width") || "0") || 0;
      const totalHeight = Number.parseFloat(container.getAttribute("data-height") || container.getAttribute("height") || "0") || 0;

      const containerRect = container.getBoundingClientRect();
      const viewport = {
        left: containerRect.left,
        top: containerRect.top,
        width: containerRect.width,
        height: containerRect.height,
      };

      const offsetX = 7 * marginX;
      const offsetY = 38.2 * marginY;

      const transform = page.transform.baseVal.consolidate()?.matrix;
      if (transform) {
        viewport.left += (transform.e / totalWidth) * viewport.width;
        viewport.top += (transform.f / totalHeight) * viewport.height;
      }

      const body = document.body || document.firstElementChild!;
      const bodyRect = body.getBoundingClientRect();
      const scrollLeft = viewport.left - bodyRect.left + (posX / totalWidth) * viewport.width - offsetX;
      const scrollTop = viewport.top - bodyRect.top + (posY / totalHeight) * viewport.height - offsetY;
      const rippleLeft = scrollLeft + offsetX;
      const rippleTop = scrollTop + offsetY;

      window.scrollTo({ behavior, left: scrollLeft, top: scrollTop });
      if (behavior !== "instant") {
        triggerRipple(body, rippleLeft, rippleTop, "typst-jump-ripple", "typst-jump-ripple-effect .4s linear");
      }
      assignHash(index, posX, posY);
      return;
    }
  }
};

function triggerRipple(container: Element, x: number, y: number, cls: string, animation: string) {
  const ripple = document.createElement("div");
  ripple.className = cls;
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  container.appendChild(ripple);
  ripple.style.animation = animation;
  ripple.onanimationend = () => {
    container.removeChild(ripple);
  };
}

declare global {
  interface Window {
    typstGetRelatedElements?: (element: Element) => Element[] | undefined;
    typstProcessSvg: (docRoot: SVGElement, options?: { layoutText?: boolean }) => void;
    layoutText: (docRoot: SVGElement, context: { flow: Element[] }) => void;
    handleTypstLocation: (
      docRoot: Element,
      pageNumber: number,
      posX: number,
      posY: number,
      options?: { behavior?: ScrollBehavior }
    ) => void;
    assignSemaHash?: (page: number, x: number, y: number) => void;
  }
}

if (document.currentScript) {
  console.log("new svg util updated 37", performance.now());
  const docRoot = findAncestor(document.currentScript as HTMLScriptElement, "typst-doc");
  if (docRoot) {
    window.typstProcessSvg(docRoot as unknown as SVGElement);
  }
}

export {};
