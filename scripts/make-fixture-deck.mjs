/**
 * Builds a small synthetic .pptx so verify-ui can run without a client deck:
 *   node scripts/make-fixture-deck.mjs   ->  scripts/__fixture-deck.pptx
 *
 * Slide 1 carries text the rule engine reacts to (a TBD placeholder and a
 * misspelling); slides 2-4 each embed a distinct rendered PNG large enough to
 * be selected for the AI image pass. Three distinct images matter: the mock AI
 * plants its typo on every third image call, so a deck with fewer than three
 * unique images would never receive an in-image finding. Pair with
 * scripts/mock-ai.mjs for a keyless AI run.
 */
import { strToU8, zipSync } from "fflate";
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W = 9_144_000;
const H = 5_143_500;

const mockupSvg = (title, accent) => `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
  <rect width="640" height="360" fill="#f4f4f5"/>
  <rect x="40" y="40" width="560" height="220" rx="12" fill="#ffffff" stroke="#d4d4d8"/>
  <text x="70" y="100" font-family="Arial" font-size="28" fill="#18181b">${title}</text>
  <text x="70" y="150" font-family="Arial" font-size="18" fill="#52525b">Review your order and confirm.</text>
  <rect x="70" y="190" width="180" height="48" rx="8" fill="${accent}"/>
  <text x="100" y="222" font-family="Arial" font-size="22" fill="#ffffff">Submitt</text>
</svg>`;
const mockupPngs = await Promise.all(
  [
    ["Checkout", "#4f46e5"],
    ["Dashboard", "#0d9488"],
    ["Settings", "#b45309"],
  ].map(([title, accent]) => sharp(Buffer.from(mockupSvg(title, accent))).png().toBuffer()),
);

const xml = (value) => strToU8(value.trim());

const textShape = (id, name, text, x, y, w, h, size = 2400) => `
  <p:sp>
    <p:nvSpPr>
      <p:cNvPr id="${id}" name="${name}"/>
      <p:cNvSpPr/>
      <p:nvPr/>
    </p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    </p:spPr>
    <p:txBody>
      <a:bodyPr/><a:lstStyle/>
      <a:p><a:r><a:rPr sz="${size}"><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p>
    </p:txBody>
  </p:sp>`;

const mockupSlide = (slideId, shapeId, caption, imageIndex) => `
    <p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">
      <p:cSld>
        <p:spTree>
          ${textShape(shapeId, "Caption", caption, 500_000, 400_000, 6_000_000, 600_000)}
          <p:pic>
            <p:nvPicPr>
              <p:cNvPr id="${shapeId + 1}" name="${caption}"/>
              <p:cNvPicPr/>
              <p:nvPr/>
            </p:nvPicPr>
            <p:blipFill>
              <a:blip r:embed="rIdImg${imageIndex}"/>
              <a:stretch><a:fillRect/></a:stretch>
            </p:blipFill>
            <p:spPr>
              <a:xfrm><a:off x="2286000" y="1285875"/><a:ext cx="4572000" cy="2571750"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            </p:spPr>
          </p:pic>
        </p:spTree>
      </p:cSld>
    </p:sld>`;

const mockupRels = (imageIndex) => `
    <Relationships>
      <Relationship Id="rIdImg${imageIndex}" Target="../media/image${imageIndex}.png"/>
    </Relationships>`;

const zip = zipSync({
  "ppt/presentation.xml": xml(`
    <p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}">
      <p:sldIdLst>
        <p:sldId id="256" r:id="rId1"/>
        <p:sldId id="257" r:id="rId2"/>
        <p:sldId id="258" r:id="rId3"/>
        <p:sldId id="259" r:id="rId4"/>
      </p:sldIdLst>
      <p:sldSz cx="${W}" cy="${H}"/>
    </p:presentation>`),
  "ppt/_rels/presentation.xml.rels": xml(`
    <Relationships>
      <Relationship Id="rId1" Target="slides/slide1.xml"/>
      <Relationship Id="rId2" Target="slides/slide2.xml"/>
      <Relationship Id="rId3" Target="slides/slide3.xml"/>
      <Relationship Id="rId4" Target="slides/slide4.xml"/>
    </Relationships>`),
  "ppt/slides/slide1.xml": xml(`
    <p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">
      <p:cSld>
        <p:spTree>
          ${textShape(1, "Title", "Project Proposal", 500_000, 400_000, 6_000_000, 700_000, 3600)}
          ${textShape(2, "Body", "We will recieve the final assets next week.", 500_000, 1_400_000, 7_000_000, 600_000)}
          ${textShape(3, "Placeholder", "Budget: TBD", 500_000, 2_200_000, 4_000_000, 600_000)}
        </p:spTree>
      </p:cSld>
    </p:sld>`),
  "ppt/slides/slide2.xml": xml(mockupSlide(257, 4, "Checkout flow mockup", 1)),
  "ppt/slides/_rels/slide2.xml.rels": xml(mockupRels(1)),
  "ppt/slides/slide3.xml": xml(mockupSlide(258, 6, "Dashboard mockup", 2)),
  "ppt/slides/_rels/slide3.xml.rels": xml(mockupRels(2)),
  "ppt/slides/slide4.xml": xml(mockupSlide(259, 8, "Settings mockup", 3)),
  "ppt/slides/_rels/slide4.xml.rels": xml(mockupRels(3)),
  "ppt/media/image1.png": new Uint8Array(mockupPngs[0]),
  "ppt/media/image2.png": new Uint8Array(mockupPngs[1]),
  "ppt/media/image3.png": new Uint8Array(mockupPngs[2]),
});

writeFileSync("scripts/__fixture-deck.pptx", zip);
console.log(`wrote scripts/__fixture-deck.pptx (${zip.byteLength} bytes)`);
