export interface DocumentParser {
  parse(filePath: string): Promise<ParsedDocument>;
}

export type ParsedDocument = {
  pages: Array<{
    pageNumber: number;
    content: string;
  }>;
};
