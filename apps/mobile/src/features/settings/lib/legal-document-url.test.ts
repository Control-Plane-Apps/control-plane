import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { ALLOWED_LEGAL_DOCUMENT_URLS, isLegalDocumentUrl } from "./legal-document-url";

const SITE_PUBLIC_DIR = NodePath.resolve(__dirname, "../../../../../control-plane-site/public");

describe("legal document URLs", () => {
  it.each(ALLOWED_LEGAL_DOCUMENT_URLS)("%s is a page on the marketing site", (url) => {
    const { origin, pathname } = new URL(url);
    expect(origin).toBe("https://controlplane.work");
    expect(
      NodeFS.existsSync(
        NodePath.resolve(SITE_PUBLIC_DIR, `${pathname.replace(/^\/+|\/+$/g, "")}.html`),
      ),
    ).toBe(true);
  });
});

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://controlplane.work/legal",
    "https://controlplane.work/legal/",
    "https://controlplane.work/privacy-policy?source=app",
    "https://controlplane.work/terms-of-service#updates",
    "https://controlplane.work/security-policy",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://controlplane.work/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
