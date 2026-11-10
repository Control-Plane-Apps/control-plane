import type { OrchestrationReadModel, ProjectStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyStatusUpsert } from "./statusDecider.ts";

const NOW = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-10T13:00:00.000Z";
const readModel = { projects: [], threads: [] } as unknown as OrchestrationReadModel;

/** A record written before the compact-row limits: long lines, no answer label. */
const LEGACY: ProjectStatus = {
  id: "release",
  title: "Release 18.6",
  state: "needs-you",
  summary: `On Preview with pricing, TREC fixes, report link, chat files and documents by state. ${"x".repeat(100)}`,
  decision: {
    question: `Ship to Production once green, or test Preview yourself first? ${"y".repeat(100)}`,
    recommendation: "Ship to Production once #3116 and #3140 are green, TREC dry run first",
    deadline: "2026-11-12T17:00:00.000Z",
    openedAt: NOW,
    autoAccept: { openedAt: NOW, enabledAt: NOW },
  },
  updatedAt: NOW,
};

const upsert = (
  change: Record<string, unknown>,
  statuses: ReadonlyArray<ProjectStatus> = [LEGACY],
) =>
  applyStatusUpsert({
    readModel,
    projectId: "p",
    statuses,
    change: { kind: "upsert", id: "release", ...change } as never,
    now: LATER,
  });

describe("compact row limits", () => {
  it("refuses new writes past the collapsed-row limits, with the limit in the reason", () => {
    const fresh = { id: "new", title: "New", summary: "Fine." };
    const refuse = (change: Record<string, unknown>) => upsert({ ...fresh, ...change }, []);
    expect(refuse({ summary: "s".repeat(61) })).toBe("The summary is at most 60 characters.");
    expect(refuse({ question: "q".repeat(81), recommendation: "r", answer: "a" })).toBe(
      "The question is at most 80 characters.",
    );
    expect(refuse({ question: "Q?", recommendation: "r", answer: "a".repeat(25) })).toBe(
      "The answer label is at most 24 characters.",
    );
    expect(refuse({ question: "Q?", recommendation: "Do the thing" })).toBe(
      "A decision needs your recommended answer as a short button label (answer).",
    );
    expect(
      refuse({ question: "Q?", recommendation: "Do the thing", answer: "Do it" }),
    ).toMatchObject({
      decision: {
        question: "Q?",
        recommendation: "Do the thing",
        answer: "Do it",
        openedAt: LATER,
      },
    });
  });

  it("keeps an older record's long text and version when other fields change", () => {
    const next = upsert({ agents: [] }) as ProjectStatus;
    expect(next.summary).toBe(LEGACY.summary);
    expect(next.decision).toEqual(LEGACY.decision);
    // The opt-in the user gave this version survives an unrelated edit.
    expect(next.decision?.autoAccept).toEqual(LEGACY.decision?.autoAccept);
  });

  it("adds a why without changing the version the user opted in to", () => {
    const next = upsert({ why: "The TREC script runs dry first." }) as ProjectStatus;
    expect(next.decision?.openedAt).toBe(NOW);
    expect(next.decision?.autoAccept).toBeDefined();
    expect(next.decision?.why).toBe("The TREC script runs dry first.");
  });

  it("requires an answer label to re-ask an older question, and restamps it", () => {
    expect(upsert({ question: "Ship once green?" })).toBe(
      "A decision needs your recommended answer as a short button label (answer).",
    );
    const next = upsert({
      question: "Ship once green?",
      answer: "Ship once green",
    }) as ProjectStatus;
    expect(next.decision).toMatchObject({ answer: "Ship once green", openedAt: LATER });
    expect(next.decision?.autoAccept).toBeUndefined();
  });

  it("treats a new answer label as a new version, which drops the opt-in", () => {
    const labelled = upsert({ answer: "Ship once green" }) as ProjectStatus;
    expect(labelled.decision?.openedAt).toBe(LATER);
    expect(labelled.decision?.autoAccept).toBeUndefined();
  });

  it("needs a fresh label for a new question or recommendation, not the old one", () => {
    const labelled = upsert({ question: "Ship now?", answer: "Ship now" }) as ProjectStatus;
    const statuses = [labelled];
    expect(upsert({ recommendation: "Hold until QA signs off Monday" }, statuses)).toBe(
      "A decision needs your recommended answer as a short button label (answer).",
    );
    expect(upsert({ question: "Wait for QA?" }, statuses)).toBe(
      "A decision needs your recommended answer as a short button label (answer).",
    );
    // A deadline-only change keeps the label it already had.
    const moved = upsert({ deadline: "2026-11-13T17:00:00.000Z" }, statuses) as ProjectStatus;
    expect(moved.decision?.answer).toBe("Ship now");
  });

  it("asks an older decision for a label when its deadline moves", () => {
    expect(upsert({ deadline: "2026-11-13T17:00:00.000Z" })).toBe(
      "A decision needs your recommended answer as a short button label (answer).",
    );
  });

  it("drops the old why when the recommendation is reworded", () => {
    const withWhy = upsert({ why: "CI is green." }) as ProjectStatus;
    const next = upsert({ recommendation: "Hold until QA on Monday", answer: "Hold" }, [
      withWhy,
    ]) as ProjectStatus;
    expect(next.decision?.recommendation).toBe("Hold until QA on Monday");
    expect(next.decision?.why).toBeUndefined();
    const explained = upsert(
      { recommendation: "Hold until QA on Monday", answer: "Hold", why: "QA finds more." },
      [withWhy],
    ) as ProjectStatus;
    expect(explained.decision?.why).toBe("QA finds more.");
  });

  it("clears a why without needing a decision", () => {
    const plain: ProjectStatus = {
      id: "release",
      title: "R",
      state: "working",
      summary: "S",
      updatedAt: NOW,
    };
    expect(upsert({ why: "" }, [plain])).toMatchObject({ summary: "S" });
    const withWhy = upsert({ why: "Because." }) as ProjectStatus;
    expect((upsert({ why: "" }, [withWhy]) as ProjectStatus).decision?.why).toBeUndefined();
  });
});
