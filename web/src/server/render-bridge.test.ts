import { describe, expect, it } from "vitest";
import { injectRenderBridge } from "./render-bridge";

describe("injectRenderBridge", () => {
  it("injects the inspector bridge script before </body>", () => {
    const html = "<!doctype html><html><head></head><body><h1>Report</h1></body></html>";
    const result = injectRenderBridge(html);

    expect(result).toContain("data-pagelet-bridge");
    expect(result).toContain("__pageletInspectorBridge");
    expect(result.indexOf("<script data-pagelet-bridge>")).toBeLessThan(
      result.indexOf("</body>")
    );
    // preserves existing content
    expect(result).toContain("<h1>Report</h1>");
  });

  it("appends the bridge when there is no </body>", () => {
    const html = "<div>no body</div>";
    const result = injectRenderBridge(html);

    expect(result).toContain("data-pagelet-bridge");
    expect(result.startsWith("<div>no body</div><script data-pagelet-bridge>"))
      .toBe(true);
  });

  // The bridge runs inside the report iframe, and there is no DOM environment
  // in this suite to execute it against. These assertions cover the wiring --
  // that selection capture is present and preferred over the element under the
  // cursor -- not the runtime behaviour, which is checked by hand in a browser.
  it("prefers a text selection over the element under the cursor", () => {
    const source = injectRenderBridge("<body></body>");

    expect(source).toContain("window.getSelection");
    expect(source).toContain("selectionAnchor");
    // mouseup is where a drag-select finishes, so a reviewer does not have to
    // click again after highlighting a sentence.
    expect(source).toContain('addEventListener("mouseup"');
    // The click handler consults the selection before falling back.
    const clickHandler = source.slice(source.indexOf('addEventListener("click"'));
    expect(clickHandler.indexOf("selectionAnchor()")).toBeLessThan(
      clickHandler.indexOf("anchorFor(el)")
    );
  });

  it("sends the selected words, not only their hash", () => {
    const source = injectRenderBridge("<body></body>");

    expect(source).toContain("quotedText: selected.slice(0, 300)");
  });

  it("is idempotent", () => {
    const html = "<body></body>";
    const once = injectRenderBridge(html);
    const twice = injectRenderBridge(once);

    expect(twice.match(/data-pagelet-bridge/g)?.length).toBe(1);
  });
});
