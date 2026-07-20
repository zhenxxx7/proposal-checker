import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import { strToU8, zipSync } from "fflate";
import { imageCropRect } from "../lib/aiClient";
import { runRuleChecks } from "../lib/checks";
import { resolveFillElement, themeFillElement } from "../lib/color";
import { parsePptx } from "../lib/pptx";
import {
  applyFeedbackLearning,
  createFeedbackDeckIdentity,
  feedbackLearningKey,
  findingFingerprint,
  type FeedbackRecord,
} from "../lib/feedback";
import type { Deck, Finding, Para, TextShape } from "../lib/types";

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W = 9_144_000;
const H = 5_143_500;
const paragraph = (text: string, color: string): Para => ({
  text,
  sizes: [24],
  runs: [{ text, size: 24, color }],
});
const textShape = (
  id: string,
  text: string,
  color: string,
  rect: TextShape["rect"],
  fill?: TextShape["fill"],
): TextShape => ({
  kind: "text",
  id,
  name: id,
  rect,
  rot: 0,
  paragraphs: [paragraph(text, color)],
  fill,
});

const foreground = textShape(
  "foreground",
  "Readable title",
  "#ffffff",
  { x: 500_000, y: 500_000, w: 3_000_000, h: 600_000 },
);
const offCanvas = textShape(
  "off-canvas",
  "Presented by FXMedia PTE LTD",
  "#ffffff",
  { x: W + 100_000, y: 0, w: 2_000_000, h: 500_000 },
);
const darkPanel = textShape(
  "master-panel",
  "",
  "#ffffff",
  { x: 0, y: 0, w: W, h: H },
  { type: "solid", color: "#10143a" },
);
darkPanel.paragraphs = [];

const deck: Deck = {
  widthEmu: W,
  heightEmu: H,
  slides: [{
    index: 1,
    background: { type: "solid", color: "#ffffff" },
    backgroundShapes: [darkPanel],
    shapes: [foreground, offCanvas],
  }],
  media: new Map(),
  blobs: new Map(),
};

const findings = runRuleChecks(deck);
assert.equal(
  createFeedbackDeckIdentity("original.pptx", deck).fingerprint,
  createFeedbackDeckIdentity("renamed.pptx", deck).fingerprint,
  "deck learning identity must survive a filename change",
);
assert.ok(
  findings.every((finding) => !finding.shapeIds?.includes("off-canvas")),
  "fully off-canvas shapes must be invisible to all rule checks",
);
assert.ok(
  !findings.some((finding) => finding.code === "text.low-contrast" && finding.shapeIds?.includes("foreground")),
  "master/layout panels must be considered when checking text contrast",
);

const whiteDeck: Deck = {
  ...deck,
  slides: [{ ...deck.slides[0], backgroundShapes: [], shapes: [foreground] }],
};
assert.ok(
  runRuleChecks(whiteDeck).some(
    (finding) => finding.code === "text.low-contrast" && finding.shapeIds?.includes("foreground"),
  ),
  "the contrast rule must still report genuinely invisible text",
);
const imageBackgroundDeck: Deck = {
  ...deck,
  slides: [{
    ...deck.slides[0],
    background: {
      type: "image",
      media: "ppt/media/background.png",
      crop: { l: 0, t: 0, r: 0, b: 0 },
    },
    backgroundShapes: [],
    shapes: [foreground],
  }],
};
assert.ok(
  !runRuleChecks(imageBackgroundDeck).some((finding) => finding.code === "text.low-contrast"),
  "contrast must not assume an image background is white",
);
const imageFilledTextDeck: Deck = {
  ...whiteDeck,
  slides: [{
    ...whiteDeck.slides[0],
    shapes: [{
      ...foreground,
      fill: {
        type: "image",
        media: "ppt/media/panel.png",
        crop: { l: 0, t: 0, r: 0, b: 0 },
      },
    }],
  }],
};
assert.ok(
  !runRuleChecks(imageFilledTextDeck).some((finding) => finding.code === "text.low-contrast"),
  "contrast must not assume a text box's image fill is transparent",
);
assert.deepEqual(
  Object.fromEntries(
    Object.entries(imageCropRect(1000, 500, { l: 0.1, t: 0.2, r: 0.3, b: 0.1 }))
      .map(([key, value]) => [key, Math.round(value)]),
  ),
  { x: 100, y: 100, w: 600, h: 350 },
  "AI must receive only the portion of an image visible after PowerPoint cropping",
);

const themeDoc = new DOMParser().parseFromString(`
  <a:theme xmlns:a="${NS_A}">
    <a:themeElements><a:fmtScheme name="Regression">
      <a:fillStyleLst>
        <a:gradFill>
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"/></a:gs>
            <a:gs pos="100000"><a:srgbClr val="000000"/></a:gs>
          </a:gsLst>
          <a:lin ang="0"/>
        </a:gradFill>
      </a:fillStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme></a:themeElements>
  </a:theme>
`, "application/xml") as unknown as Document;
const indexedGradient = themeFillElement(themeDoc, 1);
assert.ok(indexedGradient, "theme fillStyleLst index must resolve");
assert.deepEqual(
  resolveFillElement(indexedGradient, new Map([["phClr", "#00ff00"]])),
  { type: "gradient", css: "linear-gradient(90deg, #00ff00 0%, #000000 100%)" },
);
const indexedBackground = themeFillElement(themeDoc, 1001);
assert.ok(indexedBackground, "theme bgFillStyleLst index must resolve");
assert.deepEqual(
  resolveFillElement(indexedBackground, new Map([["phClr", "#123456"]])),
  { type: "solid", color: "#123456" },
);

const zip = zipSync({
  "ppt/presentation.xml": xml(`
    <p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}">
      <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
      <p:sldSz cx="${W}" cy="${H}"/>
    </p:presentation>`),
  "ppt/_rels/presentation.xml.rels": xml(`
    <Relationships>
      <Relationship Id="rId1" Target="slides/slide1.xml"/>
    </Relationships>`),
  "ppt/slides/slide1.xml": xml(`
    <p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">
      <p:cSld>
        <p:bg><p:bgPr>
          <a:blipFill>
            <a:blip r:embed="rIdBg"/>
            <a:srcRect l="10000" t="20000" r="0" b="0"/>
            <a:stretch><a:fillRect/></a:stretch>
          </a:blipFill>
        </p:bgPr></p:bg>
        <p:spTree>
          ${pptTextShape(1, "No fill", 0, "FF0000", 500_000)}
          ${pptTextShape(2, "Theme fill", 1, "00FF00", 1_500_000)}
        </p:spTree>
      </p:cSld>
    </p:sld>`),
  "ppt/slides/_rels/slide1.xml.rels": xml(`
    <Relationships>
      <Relationship Id="rIdBg" Target="../media/image1.png"/>
    </Relationships>`),
  "ppt/media/image1.png": Uint8Array.from(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+QhY4WQAAAABJRU5ErkJggg==", "base64"),
  ),
});
const parsed = parsePptx(
  zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer,
);
assert.deepEqual(parsed.slides[0].background, {
  type: "image",
  media: "ppt/media/image1.png",
  crop: { l: 0.1, t: 0.2, r: 0, b: 0 },
});
const [noFill, themeFill] = parsed.slides[0].shapes.filter((shape) => shape.kind === "text");
assert.equal(noFill?.fill, undefined, "fillRef idx=0 must remain transparent");
assert.deepEqual(themeFill?.fill, { type: "solid", color: "#00ff00" });

verifyLocalFeedbackLearning();
console.log("PASS feedback regressions: rules, preview fills, structured ratings, and local learning.");

function xml(value: string) {
  return strToU8(value.trim());
}

function pptTextShape(id: number, text: string, fillIndex: number, fillColor: string, y: number) {
  return `
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="Shape ${id}"/>
        <p:cNvSpPr/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="500000" y="${y}"/><a:ext cx="3000000" cy="500000"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </p:spPr>
      <p:style>
        <a:fillRef idx="${fillIndex}"><a:srgbClr val="${fillColor}"/></a:fillRef>
      </p:style>
      <p:txBody>
        <a:bodyPr/><a:lstStyle/>
        <a:p><a:r><a:rPr sz="2400"/><a:t>${text}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>`;
}

function verifyLocalFeedbackLearning() {
  const rejectedFinding: Finding = {
    id: "ai-rejected",
    code: "ai.image",
    slide: 2,
    severity: "warn",
    category: "image-text",
    source: "ai-image",
    title: "“Submitt”",
    detail: "Primary CTA button reads “Submitt”.",
    quote: "Submitt",
    suggestion: "Submit",
  };
  const repeatedPattern: Finding = {
    ...rejectedFinding,
    id: "ai-repeated",
    slide: 7,
    severity: "error",
    title: "\"submitt\"",
    detail: "The right-side button reads “submitt”.",
    quote: "submitt",
    suggestion: "  SUBMIT  ",
  };
  const differentPattern: Finding = {
    ...rejectedFinding,
    id: "ai-different",
    quote: "Submitt now",
    suggestion: "Submit now",
  };
  const ruleFinding: Finding = {
    id: "rule-kept",
    code: "text.placeholder",
    slide: 1,
    severity: "error",
    category: "placeholder",
    source: "rule",
    title: "Placeholder text",
    detail: "TBD remains on the slide.",
    quote: "TBD",
  };
  const firstDeck = { name: "First deck.pptx", fingerprint: "deck-v1-first" };
  const unrelatedSameName = { name: "First deck.pptx", fingerprint: "deck-v1-unrelated" };
  const renamedFirstDeck = { name: "Renamed deck.pptx", fingerprint: firstDeck.fingerprint };
  const secondDeck = { name: "Second deck.pptx", fingerprint: "deck-v1-second" };
  const thirdDeck = { name: "Third deck.pptx", fingerprint: "deck-v1-third" };
  const rejection: FeedbackRecord = {
    schemaVersion: 1,
    id: "feedback-rejected",
    fingerprint: findingFingerprint(rejectedFinding),
    rating: "not-useful",
    createdAt: "2026-07-18T01:00:00.000Z",
    deck: { ...firstDeck, slideCount: 10 },
    finding: {
      source: "ai-image",
      code: "ai.image",
      slide: rejectedFinding.slide,
      severity: rejectedFinding.severity,
      category: rejectedFinding.category,
      title: rejectedFinding.title,
      detail: rejectedFinding.detail,
      quote: rejectedFinding.quote,
      suggestion: rejectedFinding.suggestion,
    },
  };

  assert.equal(
    feedbackLearningKey(rejectedFinding),
    feedbackLearningKey(repeatedPattern),
    "learning identity must survive slide, severity, location, quote case, and suggestion whitespace changes",
  );
  assert.notEqual(
    feedbackLearningKey(rejectedFinding),
    feedbackLearningKey({ ...repeatedPattern, suggestion: "Leave this label unchanged." }),
    "the same common quote with a different correction must remain a distinct learning pattern",
  );
  const learned = applyFeedbackLearning(
    [ruleFinding, repeatedPattern, differentPattern],
    [rejection],
    firstDeck,
  );
  assert.deepEqual(
    learned.findings.map((finding) => finding.id),
    ["rule-kept", "ai-different"],
    "Not useful must hide only the repeated AI pattern and never affect rule findings",
  );
  assert.equal(learned.skipped, 1);

  const renamedDeckLearned = applyFeedbackLearning([repeatedPattern], [rejection], renamedFirstDeck);
  assert.equal(renamedDeckLearned.skipped, 1, "renaming one deck must preserve its local choice");

  const oneDeckOnly = applyFeedbackLearning([repeatedPattern], [rejection], unrelatedSameName);
  assert.deepEqual(
    oneDeckOnly.findings.map((finding) => finding.id),
    ["ai-repeated"],
    "an unrelated deck with the same filename must not inherit immediate suppression",
  );

  const anotherDeckRejection: FeedbackRecord = {
    ...rejection,
    id: "feedback-another-deck",
    createdAt: "2026-07-18T01:30:00.000Z",
    deck: { ...secondDeck, slideCount: 10 },
  };
  const crossDeckLearned = applyFeedbackLearning(
    [repeatedPattern],
    [rejection, anotherDeckRejection],
    thirdDeck,
  );
  assert.equal(
    crossDeckLearned.skipped,
    1,
    "two distinct decks that agree may suppress the same stable pattern",
  );

  const laterUseful: FeedbackRecord = {
    ...rejection,
    id: "feedback-useful",
    rating: "useful",
    createdAt: "2026-07-18T02:00:00.000Z",
  };
  const relearned = applyFeedbackLearning(
    [repeatedPattern],
    [rejection, laterUseful],
    firstDeck,
  );
  assert.deepEqual(
    relearned.findings.map((finding) => finding.id),
    ["ai-repeated"],
    "a newer Useful choice must override the learned rejection",
  );
  assert.equal(relearned.skipped, 0);
}
