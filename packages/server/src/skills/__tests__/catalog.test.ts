import { describe, it, expect } from "vitest";
import {
  getBundledCatalog,
  getAllTags,
  filterCatalog,
  searchClawHub,
} from "../catalog.js";

describe("getBundledCatalog()", () => {
  it("returns exactly 52 entries", () => {
    expect(getBundledCatalog()).toHaveLength(52);
  });

  it("returns a new array on each call (not the internal reference)", () => {
    const a = getBundledCatalog();
    const b = getBundledCatalog();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("all entries have required fields", () => {
    for (const entry of getBundledCatalog()) {
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.source).toBe("bundled");
      expect(entry.category).toBeTruthy();
      expect(Array.isArray(entry.tags)).toBe(true);
      expect(entry.tags.length).toBeGreaterThan(0);
    }
  });

  it("all names are unique", () => {
    const names = getBundledCatalog().map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all categories are valid", () => {
    const valid = new Set([
      "dev",
      "social",
      "productivity",
      "creative",
      "communication",
      "iot",
      "utility",
      "ai",
    ]);
    for (const entry of getBundledCatalog()) {
      expect(valid.has(entry.category)).toBe(true);
    }
  });

  it("specific entries have correct metadata (spot check)", () => {
    const catalog = getBundledCatalog();
    const github = catalog.find((e) => e.name === "github");
    expect(github).toBeDefined();
    expect(github!.category).toBe("dev");
    expect(github!.tags).toContain("github");
    expect(github!.requires?.bins).toContain("gh");

    const weather = catalog.find((e) => e.name === "weather");
    expect(weather).toBeDefined();
    expect(weather!.category).toBe("utility");
    expect(weather!.requires).toBeUndefined();
  });
});

describe("getAllTags()", () => {
  it("returns unique tags", () => {
    const tags = getAllTags();
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("returns tags sorted alphabetically", () => {
    const tags = getAllTags();
    const sorted = [...tags].sort();
    expect(tags).toEqual(sorted);
  });

  it("contains expected tags", () => {
    const tags = getAllTags();
    expect(tags).toContain("github");
    expect(tags).toContain("macos");
    expect(tags).toContain("tts");
    expect(tags).toContain("smarthome");
  });

  it("tag count is reasonable (> 20)", () => {
    expect(getAllTags().length).toBeGreaterThan(20);
  });
});

describe("filterCatalog()", () => {
  it("filter by tag", () => {
    const results = filterCatalog({ tag: "macos" });
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) {
      expect(entry.tags).toContain("macos");
    }
  });

  it("filter by category", () => {
    const results = filterCatalog({ category: "dev" });
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) {
      expect(entry.category).toBe("dev");
    }
  });

  it("filter by query matching name", () => {
    const results = filterCatalog({ query: "github" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const names = results.map((e) => e.name);
    expect(names).toContain("github");
  });

  it("filter by query matching description", () => {
    const results = filterCatalog({ query: "IMAP" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const names = results.map((e) => e.name);
    expect(names).toContain("himalaya");
  });

  it("query is case-insensitive", () => {
    const upper = filterCatalog({ query: "GITHUB" });
    const lower = filterCatalog({ query: "github" });
    expect(upper).toEqual(lower);
  });

  it("combined filters narrow results", () => {
    const byCategory = filterCatalog({ category: "creative" });
    const combined = filterCatalog({ category: "creative", tag: "tts" });
    expect(combined.length).toBeLessThan(byCategory.length);
    expect(combined.length).toBeGreaterThan(0);
    for (const entry of combined) {
      expect(entry.category).toBe("creative");
      expect(entry.tags).toContain("tts");
    }
  });

  it("returns empty array when no match", () => {
    const results = filterCatalog({ query: "nonexistent-xyz-12345" });
    expect(results).toEqual([]);
  });

  it("returns all entries with no filters", () => {
    const results = filterCatalog({});
    expect(results).toHaveLength(52);
  });
});

describe("searchClawHub()", () => {
  it("returns empty array (placeholder)", async () => {
    const results = await searchClawHub("anything");
    expect(results).toEqual([]);
  });
});
