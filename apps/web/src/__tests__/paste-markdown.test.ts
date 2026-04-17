import { describe, it, expect } from "vitest";
import { markdownToBlocks, isLikelyMarkdown } from "@/editor/paste-markdown";

describe("markdownToBlocks", () => {
  it("detects markdown content heuristically", () => {
    expect(isLikelyMarkdown("# heading")).toBe(true);
    expect(isLikelyMarkdown("- item")).toBe(true);
    expect(isLikelyMarkdown("plain text")).toBe(false);
  });

  it("converts headings and paragraphs", () => {
    const blocks = markdownToBlocks("# Title\n\nHello **world**.");
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.type).toBe("heading");
    expect((blocks[0]!.content.attrs as { level: number }).level).toBe(1);
    expect(blocks[1]!.type).toBe("paragraph");
    const p = blocks[1]!.content.children!;
    expect(p.some((c) => c.type === "text" && c.text.includes("world") && c.marks?.some((m) => m.type === "bold"))).toBe(
      true,
    );
  });

  it("converts fenced code with language", () => {
    const blocks = markdownToBlocks("```py\nprint('x')\n```\n");
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.type).toBe("code");
    expect((blocks[0]!.content.attrs as { language?: string }).language).toBe("py");
    const first = blocks[0]!.content.children![0]!;
    expect(first.type).toBe("text");
    if (first.type === "text") {
      expect(first.text).toContain("print");
    }
  });

  it("converts hr to divider", () => {
    const blocks = markdownToBlocks("---\n");
    expect(blocks[0]!.type).toBe("divider");
  });

  it("converts bulleted lists to bulleted_list blocks", () => {
    const blocks = markdownToBlocks("- one\n- two\n");
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.type).toBe("bulleted_list");
    expect(blocks[1]!.type).toBe("bulleted_list");
  });

  it("converts numbered lists to numbered_list blocks", () => {
    const blocks = markdownToBlocks("1. one\n2. two\n");
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.type).toBe("numbered_list");
  });

  it("converts blockquotes", () => {
    const blocks = markdownToBlocks("> hello\n");
    expect(blocks[0]!.type).toBe("blockquote");
  });
});
