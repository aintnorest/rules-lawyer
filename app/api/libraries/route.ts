import { NextResponse } from "next/server";
import { config } from "../../../src/config";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

export async function GET() {
  const dataDir = config.dataDir;
  try {
    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    const libraries = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const manifestPath = path.join(dataDir, entry.name, "manifest.json");
          const manifestContent = await fs.readFile(manifestPath, "utf-8");
          const manifest = JSON.parse(manifestContent);
          libraries.push({ id: manifest.id, label: manifest.label });
        } catch (e) {
          // Ignore dirs without manifest
        }
      }
    }
    return NextResponse.json(libraries);
  } catch (error) {
    return NextResponse.json({ error: "Could not read libraries" }, { status: 500 });
  }
}
