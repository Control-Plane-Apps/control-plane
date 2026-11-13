import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

const publicDir = new URL("../public/", import.meta.url);
const read = (path) => NodeFS.readFileSync(new URL(path, publicDir), "utf8");

// Lucive Cloud's Task Sync checkout and portal default to these URLs
// (cloud/lib/cplaneTaskSyncCheckout.ts); cleanUrls serves them without .html.
const pages = [
  { file: "task-sync.html", noindex: false },
  { file: "task-sync/success.html", noindex: true },
  { file: "task-sync/canceled.html", noindex: true },
];

for (const page of pages) {
  NodeTest.test(`${page.file} exists, uses the site shell, and has no inline script`, () => {
    const html = read(page.file);
    NodeAssert.match(html, /<link rel="stylesheet" href="\/style.css" \/>/);
    NodeAssert.match(html, /<main id="main" class="document">/);
    NodeAssert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
    NodeAssert.equal(/name="robots" content="noindex"/.test(html), page.noindex);
    NodeAssert.doesNotMatch(html, /—/);
  });
}
