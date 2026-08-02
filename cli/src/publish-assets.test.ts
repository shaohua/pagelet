import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePublish } from "./publish-assets.js";

describe("preparePublish", () => {
  it("discovers and rewrites local HTML and CSS assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "pagelet-assets-"));
    await writeFile(
      join(root, "report.html"),
      [
        "<!doctype html>",
        "<title>Asset Test</title>",
        '<link rel="stylesheet" href="./styles.css">',
        '<img src="images/chart.svg" srcset="images/chart.svg 1x">',
        '<script src="app.js"></script>'
      ].join("\n")
    );
    await writeFile(
      join(root, "styles.css"),
      "body { background: url('./images/bg.svg'); }"
    );
    await mkdir(join(root, "images"));
    await writeFile(join(root, "app.js"), "console.log('pagelet');");
    await writeFile(join(root, "images/chart.svg"), "<svg></svg>");
    await writeFile(join(root, "images/bg.svg"), "<svg></svg>");

    const prepared = await preparePublish(join(root, "report.html"));
    const html = prepared.html.bytes.toString("utf8");
    const css = prepared.assets.find(
      (asset) => asset.draftFile.originalPath === "styles.css"
    );

    expect(html).toContain("assets/");
    expect(html).not.toContain("./styles.css");
    expect(prepared.assets.map((asset) => asset.draftFile.originalPath).sort()).toEqual([
      "app.js",
      "images/bg.svg",
      "images/chart.svg",
      "styles.css"
    ]);
    expect(css?.bytes.toString("utf8")).toContain("../");
    expect(css?.bytes.toString("utf8")).not.toContain("images/bg.svg");
  });

  it("resolves root-relative assets against the publish root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pagelet-assets-"));
    await mkdir(join(root, "pages"));
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, "pages/report.html"),
      '<!doctype html><img src="/assets/root.svg">'
    );
    await writeFile(join(root, "assets/root.svg"), "<svg></svg>");

    const prepared = await preparePublish(join(root, "pages/report.html"), root);
    const html = prepared.html.bytes.toString("utf8");

    expect(prepared.html.draftFile.originalPath).toBe("pages/report.html");
    expect(prepared.assets.map((asset) => asset.draftFile.originalPath)).toEqual([
      "assets/root.svg"
    ]);
    expect(html).toContain("assets/");
    expect(html).not.toContain("/assets/root.svg");
  });

  it("includes explicit asset globs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pagelet-assets-"));
    await mkdir(join(root, "chunks"));
    await writeFile(join(root, "report.html"), "<!doctype html><title>Explicit</title>");
    await writeFile(join(root, "chunks/runtime-a.js"), "console.log('a');");
    await writeFile(join(root, "chunks/runtime-b.js"), "console.log('b');");
    await writeFile(join(root, "chunks/unused.css"), "body { color: red; }");

    const prepared = await preparePublish(join(root, "report.html"), {
      rootDir: root,
      explicitAssets: ["/chunks/runtime-*.js"]
    });

    expect(prepared.assets.map((asset) => asset.draftFile.originalPath).sort()).toEqual([
      "chunks/runtime-a.js",
      "chunks/runtime-b.js"
    ]);
  });

  it("reports external references without rewriting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pagelet-assets-"));
    await writeFile(
      join(root, "report.html"),
      [
        "<!doctype html>",
        '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
        '<img src="//static.example.com/chart.png">',
        '<link rel="stylesheet" href="styles.css">'
      ].join("\n")
    );
    await writeFile(
      join(root, "styles.css"),
      "body { background: url('https://fonts.gstatic.com/bg.woff2'); }"
    );

    const prepared = await preparePublish(join(root, "report.html"));
    const html = prepared.html.bytes.toString("utf8");

    expect(html).toContain("https://cdn.jsdelivr.net/npm/chart.js");
    expect(html).toContain("//static.example.com/chart.png");
    expect(prepared.externalReferences.map((reference) => reference.origin).sort()).toEqual([
      "https://cdn.jsdelivr.net",
      "https://fonts.gstatic.com",
      "https://static.example.com"
    ]);
  });

  it("rejects unmatched or escaping explicit asset globs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pagelet-assets-"));
    await writeFile(join(root, "report.html"), "<!doctype html><title>Explicit</title>");

    await expect(
      preparePublish(join(root, "report.html"), {
        rootDir: root,
        explicitAssets: ["chunks/missing-*.js"]
      })
    ).rejects.toThrow("Asset include did not match any files");

    await expect(
      preparePublish(join(root, "report.html"), {
        rootDir: root,
        explicitAssets: ["../secret-*.js"]
      })
    ).rejects.toThrow("Asset include must stay inside publish root");
  });

  it("rejects paths outside the publish root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pagelet-assets-"));
    const outside = await mkdtemp(join(tmpdir(), "pagelet-outside-"));
    const outsideFile = resolve(outside, "secret.svg");

    await writeFile(outsideFile, "<svg></svg>");
    await writeFile(
      join(root, "report.html"),
      `<!doctype html><img src="${relative(root, outsideFile)}">`
    );

    await expect(preparePublish(join(root, "report.html"))).rejects.toThrow(
      "Refusing to publish path outside root"
    );
  });

  it("rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pagelet-assets-"));
    const outside = await mkdtemp(join(tmpdir(), "pagelet-outside-"));
    const outsideFile = resolve(outside, "secret.svg");

    await writeFile(outsideFile, "<svg></svg>");
    await symlink(outsideFile, join(root, "linked.svg"));
    await writeFile(root + "/report.html", '<!doctype html><img src="linked.svg">');

    await expect(preparePublish(join(root, "report.html"))).rejects.toThrow(
      "Refusing to publish path outside root"
    );
  });
});
