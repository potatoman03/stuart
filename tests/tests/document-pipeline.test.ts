import { describe, expect, it } from "vitest";
import { extractPptxParagraphsFromXml } from "@stuart/runtime-supervisor";

describe("extractPptxParagraphsFromXml", () => {
  it("keeps real slide text and drops OpenXML metadata noise", () => {
    const xml = `
      <p:spTree xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:sp>
          <p:nvSpPr>
            <p:cNvPr id="4" name="Title 1"/>
          </p:nvSpPr>
          <p:txBody>
            <a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/>
            <a:lstStyle/>
            <a:p>
              <a:r><a:rPr lang="en-SG" sz="3200"/><a:t>Myth and Common Greek Identity</a:t></a:r>
            </a:p>
            <a:p>
              <a:r><a:rPr lang="en-SG" sz="1400"/><a:t>By Archaic period, Greeks share </a:t></a:r>
              <a:r><a:rPr lang="en-SG" sz="1400" b="1"/><a:t>logoi</a:t></a:r>
              <a:r><a:rPr lang="en-SG" sz="1400"/><a:t>, mythoi, and nomoi.</a:t></a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      </p:spTree>
    `;

    expect(extractPptxParagraphsFromXml(xml)).toEqual([
      "Myth and Common Greek Identity",
      "By Archaic period, Greeks share logoi, mythoi, and nomoi.",
    ]);
  });
});
