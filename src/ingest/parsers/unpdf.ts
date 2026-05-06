import { DocumentParser, ParsedDocument } from "../types";
import { getDocumentProxy } from "unpdf";
import fs from "fs/promises";

export class UnpdfParser implements DocumentParser {
  async parse(filePath: string): Promise<ParsedDocument> {
    const buffer = await fs.readFile(filePath);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const content = textContent.items.map((item: any) => item.str).join(" ");
      pages.push({ pageNumber: i, content });
    }
    
    const totalContent = pages.map(p => p.content).join("").trim();
    if (totalContent.length < 50 && pdf.numPages > 1) {
      console.warn(`[WARN] Document ${filePath} looks like a scan-only PDF. It has almost no extractable text.`);
    }

    return { pages };
  }
}
