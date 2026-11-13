import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async (importOriginal) => ({
  ...await importOriginal<typeof import("next-intl")>(),
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/components/ui/dialog", () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Dialog: Container, DialogContent: Container, DialogHeader: Container, DialogTitle: Container };
});

import { QuickReplyPicker } from "./quick-reply-picker";

describe("QuickReplyPicker initial loading", () => {
  it("shows loading, not a false empty result, when initially opened", () => {
    const html = renderToStaticMarkup(
      <QuickReplyPicker open onOpenChange={() => {}} onPick={() => {}} />,
    );
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("quickRepliesEmpty");
  });
});
